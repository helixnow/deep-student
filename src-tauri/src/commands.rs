#![allow(non_snake_case)] // Tauri 命令参数使用 camelCase 与前端保持一致

use log::{debug, error, info, warn};

use crate::database::{Database, DatabaseManager};
use crate::database_optimizations::DatabaseOptimizationExt;
use crate::exam_sheet_service::ExamSheetService;
use crate::llm_manager::{ApiConfig, ModelProfile, VendorConfig};
#[cfg(feature = "mcp")]
use crate::mcp::McpConfig;
use crate::models::{
    AnkiDocumentGenerationRequest,
    AnkiDocumentGenerationResponse, AnkiGenerationOptions, AppError,
    CreateTemplateRequest, CustomAnkiTemplate, ExamSheetSessionDetail,
    ExamSheetSessionDetailRequest, ExamSheetSessionDetailResponse, ExamSheetSessionListRequest,
    ExamSheetSessionListResponse, ModelAssignments, PdfOcrRequest,
    PdfOcrResult, RenameExamSheetSessionRequest, RenameExamSheetSessionResponse, StreamContext, TemplateBulkImportRequest,
    TemplateExportResponse, TemplateImportRequest, UpdateExamSheetCardsRequest, UpdateExamSheetCardsResponse, UpdateTemplateRequest,
};
use crate::question_bank_service::{BatchResult, QuestionBankService, SubmitAnswerResult};
use crate::vfs::repos::AnswerSubmission;
use base64::Engine;
use rusqlite::params;

use crate::file_manager::FileManager;
use crate::pdf_ocr_service::PdfOcrService;
use crate::unified_file_manager;
use serde::{Deserialize, Serialize};
use sha2::Digest;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::env;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tauri::{AppHandle, Emitter, State, Window};
use tokio::fs;
use tokio::sync::RwLock;
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;

// Re-export from split modules
pub use crate::cmd::anki_cards::*;
pub use crate::cmd::anki_connect::*;
pub use crate::cmd::enhanced_anki::*;
pub use crate::cmd::mcp::*;
pub use crate::cmd::notes::*;
pub use crate::cmd::ocr::*;
pub use crate::cmd::textbooks::*;
pub use crate::cmd::translation::*;
pub use crate::cmd::web_search::*; // OCR 引擎配置命令

// 教材库独立数据库

const OPTIMIZE_MIN_INTERVAL_KG_SECS: i64 = 600;

fn parse_bool_flag(value: &str) -> Option<bool> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("true")
        || trimmed.eq_ignore_ascii_case("yes")
        || trimmed.eq_ignore_ascii_case("on")
        || trimmed == "1"
    {
        Some(true)
    } else if trimmed.eq_ignore_ascii_case("false")
        || trimmed.eq_ignore_ascii_case("no")
        || trimmed.eq_ignore_ascii_case("off")
        || trimmed == "0"
    {
        Some(false)
    } else {
        None
    }
}

const TEMP_RAG_UPLOAD_DIR: &str = "temp_rag_uploads";

async fn copy_exam_sheet_asset(
    file_manager: &FileManager,
    source_rel: &str,
    archive_root_rel: &str,
) -> Result<Option<String>> {
    if source_rel.trim().is_empty() {
        return Ok(None);
    }

    let source_abs = file_manager.resolve_image_path(source_rel);
    if !fs::try_exists(&source_abs)
        .await
        .map_err(|e| AppError::file_system(format!("检查整卷资源存在性失败: {}", e)))?
    {
        warn!(
            "[exam-sheet] 原始图片不存在，跳过持久化: {}",
            source_abs.display()
        );
        return Ok(None);
    }

    let file_name = Path::new(source_rel)
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| format!("asset_{}", Uuid::new_v4()));

    let normalized_root = if archive_root_rel.starts_with("images/") {
        archive_root_rel.trim_end_matches('/').to_string()
    } else {
        format!(
            "images/{}",
            archive_root_rel
                .trim_start_matches('/')
                .trim_end_matches('/')
        )
    };

    let dest_dir_abs = file_manager.resolve_image_path(&normalized_root);
    fs::create_dir_all(&dest_dir_abs)
        .await
        .map_err(|e| AppError::file_system(format!("创建整卷归档目录失败: {}", e)))?;

    let dest_abs = dest_dir_abs.join(&file_name);
    fs::copy(&source_abs, &dest_abs)
        .await
        .map_err(|e| AppError::file_system(format!("复制整卷图片失败: {}", e)))?;

    let dest_rel = format!("{}/{}", normalized_root, file_name);
    Ok(Some(dest_rel))
}

async fn persist_exam_sheet_assets(
    file_manager: &FileManager,
    exam_sheet: &mut crate::models::MistakeExamSheetLink,
    mistake_id: &str,
) -> Result<()> {
    let archive_root = format!("images/exam_sheet_archive/{}", mistake_id);

    let original_exam_id = exam_sheet.exam_id.clone();

    if let Some(original) = exam_sheet.original_image_path.clone() {
        if let Some(new_rel) = copy_exam_sheet_asset(file_manager, &original, &archive_root).await?
        {
            exam_sheet.original_image_path = Some(new_rel);
        }
    }

    if let Some(cropped) = exam_sheet.cropped_image_path.clone() {
        if let Some(new_rel) = copy_exam_sheet_asset(file_manager, &cropped, &archive_root).await? {
            exam_sheet.cropped_image_path = Some(new_rel);
        }
    }

    if exam_sheet.origin_exam_id.is_none() {
        exam_sheet.origin_exam_id = Some(original_exam_id);
    }
    exam_sheet.linked_mistake_id = Some(mistake_id.to_string());

    if exam_sheet.exam_id.trim().is_empty() {
        exam_sheet.exam_id = mistake_id.to_string();
    }
    Ok(())
}

fn persist_temp_session_to_db(state: &AppState, session: &StreamContext) -> Result<()> {
    state
        .database
        .upsert_temp_session(session)
        .map_err(|e| AppError::database(format!("持久化临时会话失败: {}", e)))
}

pub async fn cache_temp_session(state: &AppState, session: StreamContext) -> Result<()> {
    {
        let mut sessions = state.temp_sessions.lock().await;
        sessions.insert(session.temp_id.clone(), session.clone());
    }
    persist_temp_session_to_db(state, &session)?;
    Ok(())
}

async fn remove_temp_session(state: &AppState, temp_id: &str) {
    {
        let mut sessions = state.temp_sessions.lock().await;
        sessions.remove(temp_id);
    }
    if let Err(err) = state.database.delete_temp_session_record(temp_id) {
        error!(
            "[temp-session] 删除数据库临时会话失败 (temp_id={}): {}",
            temp_id, err
        );
    }
}

pub async fn get_or_restore_temp_session(state: &AppState, temp_id: &str) -> Result<StreamContext> {
    if let Some(session) = {
        let sessions = state.temp_sessions.lock().await;
        sessions.get(temp_id).cloned()
    } {
        return Ok(session);
    }

    let session = state
        .database
        .get_temp_session_record(temp_id)
        .map_err(|e| AppError::database(format!("读取临时会话失败: {}", e)))?
        .ok_or_else(|| AppError::not_found("临时会话不存在"))?;

    {
        let mut sessions = state.temp_sessions.lock().await;
        sessions.insert(temp_id.to_string(), session.clone());
    }

    Ok(session)
}

pub async fn modify_temp_session<F>(
    state: &AppState,
    temp_id: &str,
    mut mutator: F,
) -> Result<StreamContext>
where
    F: FnMut(&mut StreamContext),
{
    let mut updated = {
        let mut sessions = state.temp_sessions.lock().await;
        if let Some(session) = sessions.get_mut(temp_id) {
            mutator(session);
            Some(session.clone())
        } else {
            None
        }
    };

    if updated.is_none() {
        let mut session = state
            .database
            .get_temp_session_record(temp_id)
            .map_err(|e| AppError::database(format!("读取临时会话失败: {}", e)))?
            .ok_or_else(|| AppError::not_found("临时会话不存在"))?;
        mutator(&mut session);
        {
            let mut sessions = state.temp_sessions.lock().await;
            sessions.insert(temp_id.to_string(), session.clone());
        }
        updated = Some(session);
    }

    if let Some(session) = &updated {
        persist_temp_session_to_db(state, session)?;
    }

    updated.ok_or_else(|| AppError::not_found("临时会话不存在"))
}

pub fn merge_tags(primary: &[String], secondary: Option<&[String]>) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut merged: Vec<String> = Vec::new();

    for tag in primary.iter().chain(secondary.into_iter().flatten()) {
        let normalized = tag.trim();
        if normalized.is_empty() {
            continue;
        }
        let key = normalized.to_lowercase();
        if seen.insert(key) {
            merged.push(normalized.to_string());
        }
    }

    merged
}

use serde_json;

#[cfg(feature = "mcp")]

/// 估算文本Token数量（优先使用tiktoken；不可用时回退启发式估算）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct EstimateTokensRequest {
    #[serde(default)]
    pub model: Option<String>,
    pub texts: Vec<String>,
}

#[tauri::command]
pub async fn estimate_tokens(request: EstimateTokensRequest) -> Result<serde_json::Value> {
    let model_hint = request.model.as_deref();
    let mut per_message: Vec<usize> = Vec::with_capacity(request.texts.len());
    let mut total: usize = 0;

    for t in request.texts.iter() {
        let n = crate::utils::token_budget::estimate_tokens_with_model(t, model_hint);
        total += n;
        per_message.push(n);
    }

    // 如果编译启用了 tokenizer_tiktoken，则认为是精确计数；否则为启发式
    let precise = cfg!(feature = "tokenizer_tiktoken");
    let tokenizer = if precise { "tiktoken" } else { "heuristic" };

    Ok(serde_json::json!({
        "total": total,
        "per_message": per_message,
        "precise": precise,
        "tokenizer": tokenizer,
    }))
}

/// 硬停止：取消指定流事件（例如 chat_stream_{id}）
#[tauri::command]
pub async fn cancel_stream(streamEventName: String, state: State<'_, AppState>) -> Result<bool> {
    info!("[Backend] cancel_stream 收到前端请求: {}", streamEventName);

    debug!("[Backend] 调用 llm_manager.request_cancel_stream...");
    state
        .llm_manager
        .request_cancel_stream(&streamEventName)
        .await;

    info!("[Backend] cancel_stream 命令处理完成，返回成功");
    Ok(true)
}

/// B4: 将图片固定为会话 Pin（base64 数组）
#[tauri::command]
pub async fn pin_images(
    temp_id: String,
    images: Vec<String>,
    state: State<'_, AppState>,
) -> Result<bool> {
    let pinned = if images.is_empty() {
        None
    } else {
        Some(images.clone())
    };
    modify_temp_session(state.inner(), &temp_id, |session| {
        session.pinned_images = pinned.clone();
    })
    .await?;

    // 持久化 Pin 状态到设置表（用于跨启动恢复）
    let pin_key = format!("pinned_images:{}", temp_id);
    if images.is_empty() {
        let _ = state.database.delete_setting(&pin_key);
    } else if let Ok(images_json) = serde_json::to_string(&images) {
        let _ = state.database.save_setting(&pin_key, &images_json);
    }

    Ok(true)
}

/// B4: 取消会话 Pin 图片
#[tauri::command]
pub async fn unpin_images(temp_id: String, state: State<'_, AppState>) -> Result<bool> {
    modify_temp_session(state.inner(), &temp_id, |session| {
        session.pinned_images = None;
    })
    .await?;

    let pin_key = format!("pinned_images:{}", temp_id);
    let _ = state.database.delete_setting(&pin_key);

    Ok(true)
}

/// 保留旧调用以兼容 legacy 代码路径
fn sanitize_file_path(input: &str) -> String {
    unified_file_manager::sanitize_for_legacy(input)
}

fn normalize_dir_prefix(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.trim_end_matches('/').to_string()
}

fn normalize_bridge_image_paths(
    raw_paths: &[String],
    file_manager: &FileManager,
) -> Result<Vec<String>> {
    let mut normalized = Vec::with_capacity(raw_paths.len());
    for raw in raw_paths {
        normalized.push(normalize_single_bridge_image_path(raw, file_manager)?);
    }
    Ok(normalized)
}

fn normalize_single_bridge_image_path(
    raw_path: &str,
    file_manager: &FileManager,
) -> Result<String> {
    let trimmed = raw_path.trim_matches(char::from(0)).trim();
    if trimmed.is_empty() {
        return Err(AppError::validation("Bridge 图片路径不能为空"));
    }

    let sanitized = sanitize_file_path(trimmed);
    let cleaned_owned = sanitized
        .trim_matches(char::from(0))
        .trim()
        .replace('\\', "/");
    let mut cleaned = cleaned_owned.trim_start_matches("./").to_string();

    if cleaned.is_empty() {
        return Err(AppError::validation("Bridge 图片路径不能为空"));
    }

    if cleaned.starts_with("/images/") {
        cleaned = cleaned.trim_start_matches('/').to_string();
    }

    if cleaned.contains("..") {
        return Err(AppError::validation(format!(
            "Bridge 图片路径包含非法片段: {}",
            raw_path
        )));
    }

    if cleaned.starts_with("images/") {
        if cleaned.len() == "images/".len() {
            return Err(AppError::validation("Bridge 图片路径缺少文件名 (images/)"));
        }
        return Ok(cleaned);
    }

    let app_dir = normalize_dir_prefix(file_manager.get_app_data_dir());
    let images_dir = normalize_dir_prefix(&file_manager.images_directory());

    let looks_windows_drive = cleaned.len() > 2
        && cleaned.as_bytes()[1] == b':'
        && (cleaned.as_bytes()[2] == b'/' || cleaned.as_bytes()[2] == b'\\');
    let is_absolute = cleaned.starts_with('/') || looks_windows_drive;

    let candidate = if is_absolute {
        cleaned.clone()
    } else {
        format!(
            "{}/{}",
            app_dir,
            cleaned.trim_start_matches('/').to_string()
        )
    };

    if candidate.starts_with(&images_dir) {
        let suffix = candidate[images_dir.len()..].trim_start_matches('/');
        if suffix.is_empty() {
            return Err(AppError::validation(
                "Bridge 图片路径缺少文件名 (images 根目录)",
            ));
        }
        return Ok(format!("images/{}", suffix));
    }

    if candidate.starts_with(&app_dir) {
        let suffix = candidate[app_dir.len()..].trim_start_matches('/');
        if suffix.starts_with("images/") {
            if suffix.len() == "images/".len() {
                return Err(AppError::validation("Bridge 图片路径缺少文件名 (images/)"));
            }
            return Ok(suffix.to_string());
        }
    }

    Err(AppError::validation(format!(
        "Bridge 图片路径必须位于 `{}` 目录，收到: {}",
        images_dir, raw_path
    )))
}

/// 轻量版本查询：获取应用完整版本号（无依赖，避免阻塞）
///
/// 返回格式：`0.9.2 (Build 11792, abc12345)`
#[tauri::command]
pub async fn get_app_version() -> String {
    format!(
        "{} (Build {}, {})",
        env!("CARGO_PKG_VERSION"),
        env!("BUILD_NUMBER"),
        env!("GIT_HASH"),
    )
}

/// 获取应用数据目录的绝对路径
#[tauri::command]
pub async fn get_app_data_dir(state: State<'_, AppState>) -> Result<String> {
    Ok(state
        .file_manager
        .get_app_data_dir()
        .to_string_lossy()
        .to_string())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveDatabaseKind {
    Production,
    Test,
}

impl ActiveDatabaseKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            ActiveDatabaseKind::Production => "production",
            ActiveDatabaseKind::Test => "test",
        }
    }
}

pub struct AppState {
    pub database: Arc<Database>,                // 保留以兼容旧代码
    pub database_manager: Arc<DatabaseManager>, // 新的连接池管理器
    pub anki_database: Arc<Database>,           // Anki 独立数据库
    pub notes_database: Arc<Database>,          // 笔记系统独立数据库

    // essay_grading_db 已移除，作文批改使用 VFS 统一存储
    pub vfs_db: Option<Arc<crate::vfs::database::VfsDatabase>>,
    pub custom_mode_manager: Option<crate::essay_grading::custom_modes::CustomModeManager>,
    pub file_manager: Arc<FileManager>,
    pub exam_sheet_service: Arc<ExamSheetService>,
    pub question_bank_service: Option<Arc<QuestionBankService>>, // ★ 智能题目集服务
    pub pdf_ocr_service: Arc<PdfOcrService>,
    pub pdf_processing_service: Option<Arc<crate::vfs::PdfProcessingService>>, // ★ PDF 预处理流水线服务
    pub temp_sessions: Arc<tokio::sync::Mutex<HashMap<String, StreamContext>>>,
    pub llm_manager: Arc<crate::llm_manager::LLMManager>,
    pub notes_manager: Arc<crate::notes_manager::NotesManager>,
    pub crypto_service: Arc<crate::crypto::CryptoService>,
    // PDF-OCR 取消控制：session_id -> cancel sender
    pub pdf_ocr_cancellations:
        Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    // PDF-OCR 暂停控制：session_id -> pause sender
    pub pdf_ocr_pauses: Arc<tokio::sync::Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    // PDF-OCR 会话管理：session_id -> PdfOcrSession
    pub pdf_ocr_sessions:
        Arc<tokio::sync::Mutex<HashMap<String, crate::pdf_ocr_service::PdfOcrSession>>>,
    // PDF-OCR 跳过页面：session_id -> skip set
    pub pdf_ocr_skip_pages:
        Arc<tokio::sync::Mutex<HashMap<String, std::collections::HashSet<usize>>>>,
    pub app_handle: tauri::AppHandle,
    pub active_database: RwLock<ActiveDatabaseKind>,
}

/// 获取模板配置（从数据库获取，支持内置和自定义模板）
pub fn get_template_config(
    template_id: &str,
    database: &Arc<Database>,
) -> std::result::Result<(String, Vec<String>, String, String, String), String> {
    // 从数据库获取模板（包括内置和自定义）
    match database.get_custom_template_by_id(template_id) {
        Ok(Some(template)) => {
            let fields = template.fields.clone();
            Ok((
                template.name,
                fields,
                template.front_template,
                template.back_template,
                template.css_style,
            ))
        }
        Ok(None) => Err(format!("模板不存在: {}", template_id)),
        Err(e) => Err(format!("获取模板失败: {}", e)),
    }
}


// PDF OCR 命令组
#[tauri::command]
pub async fn init_pdf_ocr_session(
    pdf_name: Option<String>,
    pdf_base64: String,
    total_pages: usize,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String> {
    let (session_id, session) = state
        .pdf_ocr_service
        .start_session(pdf_base64, pdf_name, total_pages, app_handle)
        .await?;
    state
        .pdf_ocr_sessions
        .lock()
        .await
        .insert(session_id.clone(), session);
    Ok(session_id)
}

#[tauri::command]
pub async fn upload_pdf_ocr_page(
    session_id: String,
    page: crate::models::PdfOcrPageInput,
    state: State<'_, AppState>,
) -> Result<()> {
    // 获取 page_tx 的克隆，不持有锁
    let page_tx_opt = {
        let sessions = state.pdf_ocr_sessions.lock().await;
        sessions.get(&session_id).map(|s| s.page_tx.clone())
    };

    if let Some(page_tx) = page_tx_opt {
        // add_page 执行文件保存和发送，是 async 的
        state
            .pdf_ocr_service
            .add_page(&page_tx, &session_id, page)
            .await?;
        Ok(())
    } else {
        Err(AppError::new(
            crate::models::AppErrorType::NotFound,
            format!("Session {} not found", session_id),
        ))
    }
}

#[tauri::command]
pub async fn process_pdf_ocr(
    request: PdfOcrRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<PdfOcrResult> {
    state
        .pdf_ocr_service
        .process_pdf(request, Some(app_handle))
        .await
}

/// 取消 PDF OCR 会话（基于 session_id / temp_id）
#[tauri::command]
pub async fn cancel_pdf_ocr_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool> {
    let sender_opt = { state.pdf_ocr_cancellations.lock().await.remove(&session_id) };
    if let Some(sender) = sender_opt {
        let _ = sender.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 暂停 PDF OCR 会话
#[tauri::command]
pub async fn pause_pdf_ocr_session(session_id: String, state: State<'_, AppState>) -> Result<bool> {
    let sender_opt = { state.pdf_ocr_pauses.lock().await.get(&session_id).cloned() };
    if let Some(sender) = sender_opt {
        let _ = sender.send(true);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 继续 PDF OCR 会话
#[tauri::command]
pub async fn resume_pdf_ocr_session(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool> {
    let sender_opt = { state.pdf_ocr_pauses.lock().await.get(&session_id).cloned() };
    if let Some(sender) = sender_opt {
        let _ = sender.send(false);
        Ok(true)
    } else {
        Ok(false)
    }
}

/// 跳过指定页面
#[tauri::command]
pub async fn skip_pdf_ocr_page(
    session_id: String,
    page_index: usize,
    state: State<'_, AppState>,
) -> Result<bool> {
    let mut map = state.pdf_ocr_skip_pages.lock().await;
    map.entry(session_id)
        .or_insert_with(std::collections::HashSet::new)
        .insert(page_index);
    Ok(true)
}

/// 后端驱动的 PDF OCR（完全在后端渲染 PDF，无需前端传输图片）
///
/// 这是新的高性能 PDF OCR 入口，前端只需传入 PDF 文件路径，
/// 所有的 PDF 渲染和 OCR 处理都在后端完成，大幅减少 IPC 开销。
#[tauri::command]
pub async fn start_pdf_ocr_backend(
    pdf_path: String,
    pdf_name: Option<String>,
    render_dpi: Option<u32>,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<String> {
    let (session_id, cancel_tx, pause_tx) = state
        .pdf_ocr_service
        .start_backend_session(pdf_path, pdf_name, render_dpi, app_handle)
        .await?;

    // 存储控制通道以支持暂停/取消
    state
        .pdf_ocr_cancellations
        .lock()
        .await
        .insert(session_id.clone(), cancel_tx);
    state
        .pdf_ocr_pauses
        .lock()
        .await
        .insert(session_id.clone(), pause_tx);

    Ok(session_id)
}

/// 获取应用临时目录路径（供前端保存 PDF 文件后获取路径）
#[tauri::command]
pub async fn get_pdf_ocr_temp_dir(state: State<'_, AppState>) -> Result<String> {
    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("pdf_ocr_temp");

    // 确保目录存在
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

    Ok(temp_dir.to_string_lossy().to_string())
}

/// 将前端上传的 PDF 文件保存到临时目录
#[tauri::command]
pub async fn save_pdf_to_temp(
    pdf_base64: String,
    file_name: String,
    state: State<'_, AppState>,
) -> Result<String> {
    let temp_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("pdf_ocr_temp");

    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

    // 解码 Base64
    let base64_data = if pdf_base64.starts_with("data:") {
        pdf_base64
            .split(',')
            .nth(1)
            .unwrap_or(&pdf_base64)
            .to_string()
    } else {
        pdf_base64
    };

    let pdf_bytes =
        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &base64_data)
            .map_err(|e| AppError::validation(format!("Base64 解码失败: {}", e)))?;

    // 生成唯一文件名
    let unique_name = format!("{}_{}", uuid::Uuid::new_v4(), file_name);
    let file_path = temp_dir.join(&unique_name);

    tokio::fs::write(&file_path, pdf_bytes)
        .await
        .map_err(|e| AppError::file_system(format!("保存 PDF 文件失败: {}", e)))?;

    Ok(file_path.to_string_lossy().to_string())
}


#[tauri::command]
pub async fn list_exam_sheet_sessions(
    request: ExamSheetSessionListRequest,
    state: State<'_, AppState>,
) -> Result<ExamSheetSessionListResponse> {
    let limit = request.limit.unwrap_or(50).min(200);
    let sessions = state
        .exam_sheet_service
        .list_exam_sheet_sessions(limit)
        .await?;
    Ok(ExamSheetSessionListResponse { sessions })
}

#[tauri::command]
pub async fn get_exam_sheet_session_detail(
    request: ExamSheetSessionDetailRequest,
    state: State<'_, AppState>,
) -> Result<ExamSheetSessionDetailResponse> {
    let detail = state
        .exam_sheet_service
        .get_exam_sheet_session_detail(&request.session_id)
        .await?;
    Ok(ExamSheetSessionDetailResponse { detail })
}

#[tauri::command]
pub async fn update_exam_sheet_cards(
    request: UpdateExamSheetCardsRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<UpdateExamSheetCardsResponse> {
    let outcome = state
        .exam_sheet_service
        .update_exam_sheet_cards(request)
        .await?;

    for mistake_id in &outcome.updated_mistake_ids {
        let _ = app_handle.emit(
            "mistake_status_update",
            serde_json::json!({ "mistake_id": mistake_id }),
        );
    }

    Ok(UpdateExamSheetCardsResponse {
        detail: outcome.detail,
    })
}

#[tauri::command]
pub async fn rename_exam_sheet_session(
    request: RenameExamSheetSessionRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<RenameExamSheetSessionResponse> {
    let outcome = state
        .exam_sheet_service
        .update_exam_sheet_cards(UpdateExamSheetCardsRequest {
            session_id: request.session_id.clone(),
            cards: None,
            exam_name: request.exam_name.clone(),
            create_cards: None,
            delete_card_ids: None,
        })
        .await?;

    for mistake_id in &outcome.updated_mistake_ids {
        let _ = app_handle.emit(
            "mistake_status_update",
            serde_json::json!({ "mistake_id": mistake_id }),
        );
    }

    Ok(RenameExamSheetSessionResponse {
        summary: outcome.detail.summary.clone(),
    })
}

#[derive(Debug, serde::Deserialize)]
pub struct ImportQuestionBankRequest {
    pub content: String,
    pub format: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub folder_id: Option<String>,
    /// 可选：追加到现有题目集
    #[serde(default)]
    pub session_id: Option<String>,
    /// 可选：指定用于解析的模型配置 ID
    #[serde(default)]
    pub model_config_id: Option<String>,
    /// 可选：PDF 导入时是否优先 OCR
    /// - Some(true): 强制 OCR
    /// - Some(false): 强制使用解析文本
    /// - None: 使用后端默认策略
    #[serde(default)]
    pub pdf_prefer_ocr: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
pub struct InspectPdfTextRequest {
    pub content: String,
}

#[tauri::command]
pub async fn inspect_pdf_text_for_qbank(
    request: InspectPdfTextRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_import_service::PdfTextInspection> {
    use crate::question_import_service::QuestionImportService;

    let import_service = QuestionImportService::new(state.llm_manager.clone(), state.file_manager.clone());
    import_service.inspect_pdf_text(&request.content)
}

/// 导入题目集 - 使用统一的 QuestionImportService
///
/// 支持格式：json, txt, md, docx
/// 超长文档自动分块处理
#[tauri::command]
pub async fn import_question_bank(
    request: ImportQuestionBankRequest,
    state: State<'_, AppState>,
) -> Result<ExamSheetSessionDetail> {
    use crate::question_import_service::{ImportRequest, QuestionImportService};

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    // 使用统一的 QuestionImportService
    let import_service = QuestionImportService::new(state.llm_manager.clone(), state.file_manager.clone());

    let import_request = ImportRequest {
        content: request.content,
        format: request.format,
        name: request.name,
        session_id: request.session_id,
        folder_id: request.folder_id,
        model_config_id: request.model_config_id,
        pdf_prefer_ocr: request.pdf_prefer_ocr,
    };

    let result = import_service
        .import_document(vfs_db, import_request)
        .await?;

    // 获取完整的 session detail 返回
    state
        .exam_sheet_service
        .get_exam_sheet_session_detail(&result.session_id)
        .await
}

#[tauri::command]
pub async fn import_question_bank_stream(
    request: ImportQuestionBankRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<ExamSheetSessionDetail> {
    use crate::question_import_service::{
        ImportRequest, QuestionImportProgress, QuestionImportService,
    };

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::unbounded_channel::<QuestionImportProgress>();

    let event_forwarder = {
        let app_handle = app_handle.clone();
        tokio::spawn(async move {
            while let Some(payload) = progress_rx.recv().await {
                if let Err(err) = app_handle.emit("question_import_progress", payload) {
                    error!("[question_import_progress] emit failed: {}", err);
                }
            }
        })
    };

    let import_service = QuestionImportService::new(state.llm_manager.clone(), state.file_manager.clone());

    let import_request = ImportRequest {
        content: request.content,
        format: request.format,
        name: request.name,
        session_id: request.session_id,
        folder_id: request.folder_id,
        model_config_id: request.model_config_id,
        pdf_prefer_ocr: request.pdf_prefer_ocr,
    };

    let result = import_service
        .import_document_stream(vfs_db, import_request, Some(progress_tx))
        .await;

    if let Err(err) = event_forwarder.await {
        error!(
            "[question_import_progress] forwarder join failed: {:?}",
            err
        );
    }

    let result = result?;

    state
        .exam_sheet_service
        .get_exam_sheet_session_detail(&result.session_id)
        .await
}

// ============================================================================
// CSV 导入导出命令
// ============================================================================

/// CSV 导入请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvImportCommandRequest {
    /// 文件路径
    pub file_path: String,
    /// 目标题目集 ID
    pub exam_id: String,
    /// 字段映射：CSV 列名 -> 题目字段名
    pub field_mapping: std::collections::HashMap<String, String>,
    /// 去重策略: skip / overwrite / merge
    #[serde(default)]
    pub duplicate_strategy: Option<String>,
    /// 文件夹 ID（创建新题目集时使用）
    pub folder_id: Option<String>,
    /// 题目集名称（创建新题目集时使用）
    pub exam_name: Option<String>,
}

/// CSV 导出请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvExportCommandRequest {
    /// 题目集 ID
    pub exam_id: String,
    /// 导出文件路径
    pub file_path: String,
    /// 要导出的字段列表（为空则导出所有）
    #[serde(default)]
    pub fields: Vec<String>,
    /// 筛选条件
    #[serde(default)]
    pub filters: Option<crate::vfs::repos::QuestionFilters>,
    /// 是否包含答题记录
    #[serde(default)]
    pub include_answers: bool,
    /// 输出编码: utf8 / gbk / utf8_bom
    #[serde(default)]
    pub encoding: Option<String>,
}

/// 导入 CSV 文件到题目集
///
/// 支持字段映射、去重策略（skip/overwrite/merge）
/// 支持 UTF-8 和 GBK 编码自动检测
#[tauri::command]
pub async fn import_questions_csv(
    request: CsvImportCommandRequest,
    state: State<'_, AppState>,
    app_handle: AppHandle,
) -> Result<crate::question_import_service::CsvImportResult> {
    use crate::question_import_service::{
        CsvDuplicateStrategy, CsvImportProgress, CsvImportRequest, CsvImportService,
    };

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    // 解析去重策略
    let duplicate_strategy = match request.duplicate_strategy.as_deref() {
        Some("overwrite") => CsvDuplicateStrategy::Overwrite,
        Some("merge") => CsvDuplicateStrategy::Merge,
        _ => CsvDuplicateStrategy::Skip,
    };

    // 创建进度通道
    let (progress_tx, mut progress_rx) =
        tokio::sync::mpsc::unbounded_channel::<CsvImportProgress>();

    // 事件转发任务
    let event_forwarder = {
        let app_handle = app_handle.clone();
        tokio::spawn(async move {
            while let Some(payload) = progress_rx.recv().await {
                if let Err(err) = app_handle.emit("csv_import_progress", payload) {
                    log::warn!("[csv_import_progress] emit failed: {}", err);
                }
            }
        })
    };

    let csv_request = CsvImportRequest {
        file_path: request.file_path,
        exam_id: request.exam_id,
        field_mapping: request.field_mapping,
        duplicate_strategy,
        folder_id: request.folder_id,
        exam_name: request.exam_name,
    };

    let result = CsvImportService::import_csv(vfs_db, &csv_request, Some(progress_tx));

    // 等待事件转发完成
    if let Err(err) = event_forwarder.await {
        log::warn!("[csv_import_progress] forwarder join failed: {:?}", err);
    }

    result.map_err(|e| e.into())
}

/// 导出题目集为 CSV 文件
///
/// 支持选择导出字段、筛选条件、编码格式
#[tauri::command]
pub async fn export_questions_csv(
    request: CsvExportCommandRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_export_service::CsvExportResult> {
    use crate::question_export_service::{CsvExportRequest, CsvExportService, ExportEncoding};

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    // 解析编码
    let encoding = match request.encoding.as_deref() {
        Some("gbk") => ExportEncoding::Gbk,
        Some("utf8_bom") => ExportEncoding::Utf8Bom,
        _ => ExportEncoding::Utf8,
    };

    let export_request = CsvExportRequest {
        exam_id: request.exam_id,
        file_path: request.file_path,
        fields: request.fields,
        filters: request.filters.unwrap_or_default(),
        include_answers: request.include_answers,
        encoding,
    };

    CsvExportService::export_csv(vfs_db, &export_request).map_err(|e| e.into())
}

/// 预览 CSV 文件前 N 行（用于字段映射）
///
/// 返回表头和预览数据，支持自动编码检测
#[tauri::command]
pub async fn get_csv_preview(
    file_path: String,
    rows: Option<usize>,
) -> Result<crate::question_import_service::CsvPreviewResult> {
    use crate::question_import_service::CsvImportService;

    let preview_rows = rows.unwrap_or(5);
    CsvImportService::preview_csv(&file_path, preview_rows).map_err(|e| e.into())
}

/// 获取可导出的字段列表
#[tauri::command]
pub fn get_csv_exportable_fields() -> Vec<(String, String)> {
    use crate::question_export_service::CsvExportService;
    CsvExportService::get_exportable_fields()
}

/// 清空指定消息的向量（用于编辑重发场景）
#[tauri::command]
pub async fn clear_message_embeddings(
    message_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<()> {
    if message_ids.is_empty() {
        return Ok(());
    }

    let mut resolved_ids: Vec<i64> = Vec::new();
    let mut stable_tokens: Vec<String> = Vec::new();

    for token in message_ids {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(num) = trimmed.parse::<i64>() {
            resolved_ids.push(num);
        } else {
            stable_tokens.push(trimmed.to_string());
        }
    }

    if !stable_tokens.is_empty() {
        let conn = state
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        for stable in stable_tokens {
            let mut stmt = conn
                .prepare(
                    "SELECT id FROM chat_messages WHERE stable_id = ?1 OR persistent_stable_id = ?1",
                )
                .map_err(|e| AppError::database(e.to_string()))?;
            let rows = stmt
                .query_map(rusqlite::params![stable], |row| row.get::<_, i64>(0))
                .map_err(|e| AppError::database(e.to_string()))?;
            for row in rows {
                if let Ok(id) = row {
                    resolved_ids.push(id);
                }
            }
        }
    }

    if resolved_ids.is_empty() {
        warn!("[ClearEmbeddings] 未找到可清理的消息向量");
        return Ok(());
    }

    resolved_ids.sort_unstable();
    resolved_ids.dedup();

    let id_strings: Vec<String> = resolved_ids.iter().map(|id| id.to_string()).collect();

    let db = state.database.clone();

    if let Ok(store) = crate::lance_vector_store::LanceVectorStore::new(db.clone()) {
        if let Err(err) = store.delete_chat_embeddings_by_ids(&id_strings).await {
            error!("[ClearEmbeddings] 清空向量失败: {}", err);
            return Err(AppError::database(format!("清空向量失败: {}", err)));
        }
        info!(
            "[ClearEmbeddings] 已清空 Lance 中 {} 条消息的向量",
            resolved_ids.len()
        );
    }

    if let Err(err) = db.delete_chat_embeddings_by_ids(&resolved_ids) {
        error!("[ClearEmbeddings] 无法标记数据库 embedding_retry: {}", err);
    }

    Ok(())
}

/// 一键优化/清理聊天向量表（合并小文件、清理旧版本、优化索引）
#[tauri::command]
pub async fn optimize_chat_embeddings_table(
    older_than_days: Option<u64>,
    delete_unverified: Option<bool>,
    force: Option<bool>,
    state: State<'_, AppState>,
) -> Result<()> {
    let db = state.database.clone();
    let store = crate::lance_vector_store::LanceVectorStore::new(db.clone())
        .map_err(|e| AppError::database(e.to_string()))?;
    let optimized = store
        .optimize_chat_tables(older_than_days, delete_unverified, force.unwrap_or(true))
        .await
        .map_err(|e| AppError::database(e.to_string()))?;
    if optimized == 0 {
        debug!("[Lance优化] 聊天向量表在节流窗口内，未执行优化。");
    }
    Ok(())
}

/// 获取增强统计信息（包含所有模块）
#[tauri::command]
pub async fn get_enhanced_statistics(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let image_stats = state
        .file_manager
        .get_image_statistics()
        .await
        .map_err(|e| AppError::database(format!("获取图片统计失败: {}", e)))?;

    let enhanced_stats = serde_json::json!({
        "image_stats": image_stats,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    Ok(enhanced_stats)
}

// 专用配置管理命令

#[tauri::command]
pub async fn get_api_configurations(state: State<'_, AppState>) -> Result<Vec<ApiConfig>> {
    // 移除高频日志，避免控制台噪音

    let mut configs = state.llm_manager.get_api_configs().await?;

    for cfg in &mut configs {
        if cfg.is_builtin {
            cfg.api_key = "***".to_string();
        }
    }

    Ok(configs)
}

#[tauri::command]
pub async fn save_api_configurations(
    configs: Vec<ApiConfig>,
    state: State<'_, AppState>,
) -> Result<()> {
    info!("[后端] 接收到保存API配置请求");
    debug!("  - 配置数量: {}", configs.len());
    debug!(
        "  - 配置ID列表: {:?}",
        configs.iter().map(|c| &c.id).collect::<Vec<_>>()
    );
    debug!(
        "  - 配置名称列表: {:?}",
        configs.iter().map(|c| &c.name).collect::<Vec<_>>()
    );

    let result = state.llm_manager.save_api_configurations(&configs).await;

    match &result {
        Ok(_) => info!("[后端] API配置保存成功"),
        Err(e) => error!("[后端] API配置保存失败: {:?}", e),
    }

    result
}

#[tauri::command]
pub async fn get_model_assignments(state: State<'_, AppState>) -> Result<ModelAssignments> {
    debug!("获取模型分配配置");

    state.llm_manager.get_model_assignments().await
}

#[tauri::command]
pub async fn save_model_assignments(
    assignments: ModelAssignments,
    state: State<'_, AppState>,
) -> Result<()> {
    debug!("保存模型分配配置");

    state.llm_manager.save_model_assignments(&assignments).await
}

/// 供应商配置管理
#[tauri::command]
pub async fn get_vendor_configs(state: State<'_, AppState>) -> Result<Vec<VendorConfig>> {
    state.llm_manager.get_vendor_configs().await
}

#[tauri::command]
pub async fn save_vendor_configs(
    configs: Vec<VendorConfig>,
    state: State<'_, AppState>,
) -> Result<()> {
    state.llm_manager.save_vendor_configs(&configs).await
}

#[tauri::command]
pub async fn get_model_profiles(state: State<'_, AppState>) -> Result<Vec<ModelProfile>> {
    state.llm_manager.get_model_profiles().await
}

#[tauri::command]
pub async fn save_model_profiles(
    profiles: Vec<ModelProfile>,
    state: State<'_, AppState>,
) -> Result<()> {
    state.llm_manager.save_model_profiles(&profiles).await
}

/// 测试 API 连接
///
/// 参数说明：
/// - api_key: API 密钥（可以是 "***" 占位符）
/// - api_base: API 基础 URL
/// - model: 模型名称（可选）
/// - vendor_id: 供应商 ID（可选，用于从安全存储获取真实密钥）
#[tauri::command]
pub async fn test_api_connection(
    api_key: String,
    api_base: String,
    model: Option<String>,
    vendor_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool> {
    use reqwest::Client;
    use std::time::Duration;

    info!(
        "[API测试] 开始测试连接: base={}, model={:?}, vendor_id={:?}",
        api_base, model, vendor_id
    );

    // 解析真实的 API 密钥
    // 如果 api_key 是占位符（*** 或空），尝试从安全存储获取真实密钥
    let effective_api_key = {
        let trimmed = api_key.trim();
        let is_placeholder =
            trimmed.is_empty() || trimmed == "***" || trimmed.chars().all(|c| c == '*');

        if is_placeholder {
            // 尝试从安全存储获取真实密钥
            if let Some(vid) = &vendor_id {
                // 尝试标准格式：{vendor_id}.api_key
                let secret_key = format!("{}.api_key", vid);
                if let Ok(Some(key)) = state.database.get_secret(&secret_key) {
                    if !key.is_empty() {
                        debug!("[API测试] 从安全存储获取密钥: {}", secret_key);
                        key
                    } else {
                        // 如果是 SiliconFlow，尝试旧格式
                        if vid.contains("siliconflow") {
                            if let Ok(Some(key)) = state.database.get_secret("siliconflow.api_key")
                            {
                                if !key.is_empty() {
                                    debug!("[API测试] 从安全存储获取密钥（旧格式）: siliconflow.api_key");
                                    key
                                } else {
                                    return Err(AppError::validation(
                                        "API 密钥未配置，请先配置 API 密钥",
                                    ));
                                }
                            } else {
                                return Err(AppError::validation(
                                    "API 密钥未配置，请先配置 API 密钥",
                                ));
                            }
                        } else {
                            return Err(AppError::validation("API 密钥未配置，请先配置 API 密钥"));
                        }
                    }
                } else {
                    // 如果是 SiliconFlow，尝试旧格式
                    if vid.contains("siliconflow") {
                        if let Ok(Some(key)) = state.database.get_secret("siliconflow.api_key") {
                            if !key.is_empty() {
                                debug!(
                                    "[API测试] 从安全存储获取密钥（旧格式）: siliconflow.api_key"
                                );
                                key
                            } else {
                                return Err(AppError::validation(
                                    "API 密钥未配置，请先配置 API 密钥",
                                ));
                            }
                        } else {
                            return Err(AppError::validation("API 密钥未配置，请先配置 API 密钥"));
                        }
                    } else {
                        return Err(AppError::validation("API 密钥未配置，请先配置 API 密钥"));
                    }
                }
            } else {
                return Err(AppError::validation("请先输入 API 密钥"));
            }
        } else {
            trimmed.to_string()
        }
    };

    // 构建请求 URL
    let url = format!("{}/chat/completions", api_base.trim_end_matches('/'));

    // 构建最小化请求体
    let model_id = model.unwrap_or_else(|| "gpt-3.5-turbo".to_string());
    let request_body = serde_json::json!({
        "model": model_id,
        "messages": [{"role": "user", "content": "Hi"}],
        "max_tokens": 1,
        "stream": false
    });

    // 创建 HTTP 客户端（10 秒超时）
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| AppError::network(format!("创建HTTP客户端失败: {}", e)))?;

    // 发送请求
    let response = client
        .post(&url)
        .header(
            "Authorization",
            format!("Bearer {}", effective_api_key.trim()),
        )
        .header("Content-Type", "application/json")
        .json(&request_body)
        .send()
        .await
        .map_err(|e| AppError::network(format!("API连接测试失败: {}", e)))?;

    let status = response.status();
    if status.is_success() {
        info!("[API测试] 连接成功");
        Ok(true)
    } else {
        let error_text = response.text().await.unwrap_or_default();
        error!("[API测试] 连接失败: {} - {}", status, error_text);
        Err(AppError::network(format!(
            "API连接测试失败: {} - {}",
            status, error_text
        )))
    }
}

// ============================================================================
// Batch Operations Commands
// ============================================================================


#[derive(Debug, Deserialize)]
pub struct BatchDeleteRequest {
    pub mistake_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchOperationResult {
    pub success: bool,
    pub processed_count: usize,
    pub message: String,
}

/// 清理孤儿聊天向量（内部函数）
async fn cleanup_orphan_chat_embeddings(db: Arc<Database>) -> usize {
    // 获取所有聊天消息ID
    let all_message_ids: HashSet<String> = {
        let conn = match db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                error!("[CleanupEmbeddings] 获取连接失败: {}", e);
                return 0;
            }
        };

        let mut stmt = match conn.prepare("SELECT id FROM chat_messages") {
            Ok(s) => s,
            Err(e) => {
                error!("[CleanupEmbeddings] 准备查询失败: {}", e);
                return 0;
            }
        };

        let rows = match stmt.query_map([], |row| row.get::<_, i64>(0)) {
            Ok(r) => r,
            Err(e) => {
                error!("[CleanupEmbeddings] 查询失败: {}", e);
                return 0;
            }
        };

        let mut ids = HashSet::new();
        for row in rows {
            if let Ok(id) = row {
                ids.insert(id.to_string());
            }
        }
        ids
    };

    // 从 Lance 向量库列出所有已存在的聊天向量 message_id
    let store = match crate::lance_vector_store::LanceVectorStore::new(db.clone()) {
        Ok(s) => s,
        Err(err) => {
            error!("[CleanupEmbeddings] 初始化向量存储失败: {}", err);
            return 0;
        }
    };

    #[cfg(feature = "lance")]
    let orphan_count = {
        match store.list_all_chat_message_ids().await {
            Ok(exist_ids) => {
                // 计算 exist_ids - all_message_ids
                let mut to_delete: Vec<String> = Vec::new();
                for id in exist_ids.iter() {
                    if !all_message_ids.contains(id) {
                        to_delete.push(id.clone());
                    }
                }

                if to_delete.is_empty() {
                    debug!("[CleanupEmbeddings] 没有需要清理的孤儿向量");
                    0
                } else {
                    let n = to_delete.len();
                    if let Err(err) = store.delete_chat_embeddings_by_ids(&to_delete).await {
                        error!("[CleanupEmbeddings] 删除孤儿向量失败: {}", err);
                        0
                    } else {
                        info!("[CleanupEmbeddings] 已清理 {} 个孤儿向量", n);
                        n
                    }
                }
            }
            Err(err) => {
                error!("[CleanupEmbeddings] 枚举向量ID失败: {}", err);
                0
            }
        }
    };

    #[cfg(not(feature = "lance"))]
    let orphan_count = {
        // 未启用 Lance 特性时，不执行清理
        debug!("[CleanupEmbeddings] 未启用 lance 特性，跳过向量清理");
        0
    };

    orphan_count
}

/// Create performance indexes for better query speed
#[tauri::command]
pub async fn create_performance_indexes(state: State<'_, AppState>) -> Result<String> {
    info!("创建性能索引");

    state
        .database
        .create_performance_indexes()
        .map_err(|e| AppError::database(format!("创建性能索引失败: {}", e)))?;

    Ok("性能索引创建成功".to_string())
}

/// Analyze query performance
#[tauri::command]
pub async fn analyze_query_performance(
    query: String,
    state: State<'_, AppState>,
) -> Result<String> {
    debug!("分析查询性能: {}", query);

    let analysis = state
        .database
        .analyze_query_performance(&query)
        .map_err(|e| AppError::database(format!("查询性能分析失败: {}", e)))?;

    Ok(analysis)
}

/// 从模型输出中提取思维链内容
/// 注意：只在确有"独立推理信息"时返回，避免用完整回复充当思维链导致重复显示
fn extract_thinking_content_from_model_output(
    model_output: &crate::models::StandardModel2Output,
) -> Option<String> {
    let cot_details = match &model_output.chain_of_thought_details {
        Some(d) => d,
        None => return None,
    };

    // 1) 优先取明确的 reasoning_content（如 DeepSeek-R1 的专有字段）
    if let Some(reasoning_content) = cot_details
        .get("reasoning_content")
        .and_then(|v| v.as_str())
    {
        let rc = reasoning_content.trim();
        if !rc.is_empty() {
            return Some(rc.to_string());
        }
    }

    // 2) 尝试解析结构化片段 parsed_sections，拼接为可读内容
    if let Some(sections) = cot_details
        .get("parsed_sections")
        .and_then(|v| v.as_array())
    {
        if !sections.is_empty() {
            let formatted = sections
                .iter()
                .filter_map(|section| {
                    let title = section.get("title")?.as_str()?.trim();
                    let content = section.get("content")?.as_str()?.trim();
                    if !content.is_empty() {
                        Some(format!("## {}\n{}", title, content))
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");

            if !formatted.trim().is_empty() {
                return Some(formatted);
            }
        }
    }

    // 3) 不再回退使用 full_response 作为思维链，避免与主内容重复
    None
}

/// 获取默认的模型适配器选项
///
/// 从 ADAPTER_REGISTRY 动态获取，不再硬编码
pub fn get_default_model_adapter_options() -> Vec<serde_json::Value> {
    use crate::llm_manager::adapters::list_adapter_infos;

    list_adapter_infos()
        .into_iter()
        .map(|info| {
            serde_json::json!({
                "value": info.value,
                "label": info.label,
                "description": info.description,
                "is_default": true
            })
        })
        .collect()
}

/// 生成 Anki 卡片
#[tauri::command]
pub async fn generate_anki_cards_from_document(
    request: AnkiDocumentGenerationRequest,
    state: State<'_, AppState>,
) -> Result<AnkiDocumentGenerationResponse> {
    info!(
        "开始生成 Anki 卡片: 文档长度={}",
        request.document_content.len()
    );

    // 调用 LLM Manager 的 Anki 制卡功能
    match state
        .llm_manager
        .generate_anki_cards_from_document(
            &request.document_content,
            "通用",
            request.options.as_ref(),
        )
        .await
    {
        Ok(cards) => {
            info!("Anki 卡片生成成功: {} 张卡片", cards.len());
            Ok(AnkiDocumentGenerationResponse {
                success: true,
                cards,
                error_message: None,
            })
        }
        Err(e) => {
            error!("ANKI卡片生成失败: {}", e);
            Ok(AnkiDocumentGenerationResponse {
                success: false,
                cards: vec![],
                error_message: Some(e.to_string()),
            })
        }
    }
}
/// 从DOCX/PDF文档文件生成ANKI卡片
#[tauri::command]
pub async fn generate_anki_cards_from_document_file(
    file_path: String,
    options: Option<AnkiGenerationOptions>,
    state: State<'_, AppState>,
) -> Result<AnkiDocumentGenerationResponse> {
    info!("开始从文档文件生成ANKI卡片: 文件={}", file_path);

    // 1. 首先解析文档内容
    let document_content = match parse_document_from_path(file_path.clone()).await {
        Ok(content) => content,
        Err(e) => {
            error!("文档解析失败: {}", e);
            return Ok(AnkiDocumentGenerationResponse {
                success: false,
                cards: vec![],
                error_message: Some(format!("文档解析失败: {}", e)),
            });
        }
    };

    debug!("文档解析成功，提取文本长度: {}", document_content.len());

    // 2. 调用ANKI卡片生成
    match state
        .llm_manager
        .generate_anki_cards_from_document(&document_content, "通用学习材料", options.as_ref())
        .await
    {
        Ok(cards) => {
            info!("ANKI卡片生成成功: {} 张卡片", cards.len());
            Ok(AnkiDocumentGenerationResponse {
                success: true,
                cards,
                error_message: None,
            })
        }
        Err(e) => {
            error!("ANKI卡片生成失败: {}", e);
            Ok(AnkiDocumentGenerationResponse {
                success: false,
                cards: vec![],
                error_message: Some(e.to_string()),
            })
        }
    }
}
/// 从Base64编码的DOCX/PDF文档生成ANKI卡片
#[tauri::command]
pub async fn generate_anki_cards_from_document_base64(
    file_name: String,
    base64_content: String,
    options: Option<AnkiGenerationOptions>,
    state: State<'_, AppState>,
) -> Result<AnkiDocumentGenerationResponse> {
    info!("开始从Base64文档生成ANKI卡片: 文件={}", file_name);

    // 1. 首先解析文档内容
    let document_content = match parse_document_from_base64(file_name.clone(), base64_content).await
    {
        Ok(content) => content,
        Err(e) => {
            error!("文档解析失败: {}", e);
            return Ok(AnkiDocumentGenerationResponse {
                success: false,
                cards: vec![],
                error_message: Some(format!("文档解析失败: {}", e)),
            });
        }
    };

    debug!("文档解析成功，提取文本长度: {}", document_content.len());

    // 2. 调用ANKI卡片生成
    match state
        .llm_manager
        .generate_anki_cards_from_document(&document_content, "通用学习材料", options.as_ref())
        .await
    {
        Ok(cards) => {
            info!("ANKI卡片生成成功: {} 张卡片", cards.len());
            Ok(AnkiDocumentGenerationResponse {
                success: true,
                cards,
                error_message: None,
            })
        }
        Err(e) => {
            error!("ANKI卡片生成失败: {}", e);
            Ok(AnkiDocumentGenerationResponse {
                success: false,
                cards: vec![],
                error_message: Some(e.to_string()),
            })
        }
    }
}

/// CardForge 2.0 - LLM 定界命令
///
/// 用于智能分段引擎，让 LLM 在硬分割点附近找到最佳语义边界
#[tauri::command]
pub async fn call_llm_for_boundary(
    prompt: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    info!("调用 LLM 进行边界定界");

    // 调用 call_model2_raw_prompt 进行简单的 LLM 调用
    match state
        .llm_manager
        .call_model2_raw_prompt(&prompt, None)
        .await
    {
        Ok(output) => {
            info!("LLM 定界成功");
            // 注意：StandardModel2Output 没有 token 统计字段
            Ok(serde_json::json!({
                "assistant_message": output.assistant_message,
                "input_tokens": 0,  // 占位，实际 token 统计由后端内部处理
                "output_tokens": 0, // 占位，实际 token 统计由后端内部处理
            }))
        }
        Err(e) => {
            error!("LLM 定界失败: {}", e);
            Err(e)
        }
    }
}

// ============================================================================
// 文档解析相关命令
// ============================================================================

/// 从文件路径解析文档文本
#[tauri::command]
pub async fn parse_document_from_path(file_path: String) -> std::result::Result<String, String> {
    info!("开始解析文档: {}", file_path);

    let parser = crate::document_parser::DocumentParser::new();

    match parser.extract_text_from_path(&file_path) {
        Ok(text) => {
            debug!("文档解析成功，提取文本长度: {} 字符", text.len());
            Ok(text)
        }
        Err(err) => {
            let error_msg = format!("文档解析失败: {}", err);
            error!("{}", error_msg);
            Err(error_msg)
        }
    }
}

/// 从Base64编码内容解析文档文本
#[tauri::command]
pub async fn parse_document_from_base64(
    file_name: String,
    base64_content: String,
) -> std::result::Result<String, String> {
    info!("开始解析Base64文档: {}", file_name);

    let parser = crate::document_parser::DocumentParser::new();

    match parser.extract_text_from_base64(&file_name, &base64_content) {
        Ok(text) => {
            debug!("Base64文档解析成功，提取文本长度: {} 字符", text.len());
            Ok(text)
        }
        Err(err) => {
            let error_msg = format!("Base64文档解析失败: {}", err);
            error!("{}", error_msg);
            Err(error_msg)
        }
    }
}

/// 读取文件文本内容
#[tauri::command]
pub async fn read_file_text(window: Window, path: String) -> Result<String> {
    unified_file_manager::read_to_string(&window, &path)
}

/// 读取文件二进制内容（支持 content://、ph:// 等移动端安全URI）
#[tauri::command]
pub async fn read_file_bytes(window: Window, path: String) -> Result<Vec<u8>> {
    unified_file_manager::read_all_bytes(&window, &path)
}

/// 获取文件大小（字节）
#[tauri::command]
pub async fn get_file_size(window: Window, path: String) -> Result<u64> {
    unified_file_manager::get_file_size(&window, &path)
}
/// 计算文件 SHA-256（十六进制）
#[tauri::command]
pub async fn hash_file(window: Window, path: String) -> Result<String> {
    unified_file_manager::hash_file_sha256(&window, &path)
}
/// 复制文件到指定位置
#[tauri::command]
pub async fn copy_file(window: Window, source_path: String, dest_path: String) -> Result<()> {
    unified_file_manager::copy_file(&window, &source_path, &dest_path)?;
    Ok(())
}

/// 将文本内容保存到指定文件
#[tauri::command]
pub async fn save_text_to_file(window: Window, path: String, content: String) -> Result<()> {
    unified_file_manager::write_text_file(&window, &path, &content)
}

// 自定义模板管理命令

/// 获取所有自定义模板
#[tauri::command]
pub async fn get_all_custom_templates(
    state: State<'_, AppState>,
) -> Result<Vec<CustomAnkiTemplate>> {
    let templates = state
        .database
        .get_all_custom_templates()
        .map_err(|e| AppError::database(format!("获取模板列表失败: {}", e)))?;
    Ok(templates)
}

/// 获取指定ID的自定义模板
#[tauri::command]
pub async fn get_custom_template_by_id(
    template_id: String,
    state: State<'_, AppState>,
) -> Result<Option<CustomAnkiTemplate>> {
    let template = state
        .database
        .get_custom_template_by_id(&template_id)
        .map_err(|e| AppError::database(format!("获取模板失败: {}", e)))?;
    Ok(template)
}
/// 创建自定义模板
#[tauri::command]
pub async fn create_custom_template(
    request: CreateTemplateRequest,
    state: State<'_, AppState>,
) -> Result<String> {
    // 验证模板数据
    validate_template_request(&request)?;

    let template_id = state
        .database
        .create_custom_template(&request)
        .map_err(|e| AppError::database(format!("创建模板失败: {}", e)))?;

    Ok(template_id)
}

/// 更新自定义模板
#[tauri::command]
pub async fn update_custom_template(
    template_id: String,
    request: UpdateTemplateRequest,
    state: State<'_, AppState>,
) -> Result<()> {
    // 验证模板是否存在
    let existing_template = state
        .database
        .get_custom_template_by_id(&template_id)
        .map_err(|e| AppError::database(format!("查询模板失败: {}", e)))?;

    let existing_template = match existing_template {
        Some(template) => {
            // 允许修改所有模板，包括内置模板
            // 内置模板只是不能被删除，但可以被修改
            template
        }
        None => {
            return Err(AppError::validation("模板不存在".to_string()));
        }
    };

    if request.expected_version.is_none() {
        return Err(AppError::validation(
            "模板版本缺失，请刷新后重试".to_string(),
        ));
    }

    if let Some(expected_version) = &request.expected_version {
        if expected_version != &existing_template.version {
            return Err(AppError::validation(
                "模板已被更新，请刷新后重试".to_string(),
            ));
        }
    }

    let mut request = request;
    let merged_request = build_template_request_for_update(&existing_template, &request);
    validate_template_request(&merged_request)?;

    if request
        .version
        .as_deref()
        .is_some_and(|version| version == existing_template.version.as_str())
    {
        request.version = None;
    }

    state
        .database
        .update_custom_template(&template_id, &request)
        .map_err(|e| {
            if e.to_string().contains("optimistic_lock_failed") {
                AppError::validation("模板已被更新，请刷新后重试".to_string())
            } else {
                AppError::database(format!("更新模板失败: {}", e))
            }
        })?;

    Ok(())
}

/// 删除自定义模板
#[tauri::command]
pub async fn delete_custom_template(template_id: String, state: State<'_, AppState>) -> Result<()> {
    // 验证模板是否存在
    let existing_template = state
        .database
        .get_custom_template_by_id(&template_id)
        .map_err(|e| AppError::database(format!("查询模板失败: {}", e)))?;

    match existing_template {
        Some(_template) => {
            // 允许删除内置模板
        }
        None => {
            return Err(AppError::validation("模板不存在".to_string()));
        }
    }

    state
        .database
        .delete_custom_template(&template_id)
        .map_err(|e| AppError::database(format!("删除模板失败: {}", e)))?;

    Ok(())
}
/// 导出模板
#[tauri::command]
pub async fn export_template(
    template_id: String,
    state: State<'_, AppState>,
) -> Result<TemplateExportResponse> {
    let template = state
        .database
        .get_custom_template_by_id(&template_id)
        .map_err(|e| AppError::database(format!("查询模板失败: {}", e)))?;

    match template {
        Some(template) => {
            let template_data = serde_json::to_string_pretty(&template)
                .map_err(|e| AppError::validation(format!("序列化模板失败: {}", e)))?;

            let _filename = format!("{}_template.json", template.name.replace(" ", "_"));

            Ok(TemplateExportResponse { template_data })
        }
        None => Err(AppError::validation("模板不存在".to_string())),
    }
}
/// 导入模板
#[tauri::command]
pub async fn import_template(
    request: TemplateImportRequest,
    state: State<'_, AppState>,
) -> Result<String> {
    // 解析模板数据
    let template: CustomAnkiTemplate = serde_json::from_str(&request.template_data)
        .map_err(|e| AppError::validation(format!("解析模板数据失败: {}", e)))?;

    // 检查是否已存在同名模板
    let existing_templates = state
        .database
        .get_all_custom_templates()
        .map_err(|e| AppError::database(format!("查询现有模板失败: {}", e)))?;

    if existing_templates.iter().any(|t| t.name == template.name) {
        if !request.overwrite_existing {
            return Err(AppError::validation(format!(
                "模板 '{}' 已存在，请启用覆盖或修改名称后重试",
                template.name
            )));
        }
        // 找到同名模板并删除（包括内置模板）
        if let Some(existing) = existing_templates.iter().find(|t| t.name == template.name) {
            state
                .database
                .delete_custom_template(&existing.id)
                .map_err(|e| AppError::database(format!("删除旧模板失败: {}", e)))?;
        }
    }

    // 创建新模板
    let create_request = CreateTemplateRequest {
        name: template.name,
        description: template.description,
        author: template.author,
        version: Some(template.version),
        preview_front: template.preview_front,
        preview_back: template.preview_back,
        note_type: template.note_type,
        fields: template.fields,
        generation_prompt: template.generation_prompt,
        front_template: template.front_template,
        back_template: template.back_template,
        css_style: template.css_style,
        field_extraction_rules: template.field_extraction_rules,
        preview_data_json: template.preview_data_json,
        is_active: Some(template.is_active),
        is_built_in: Some(template.is_built_in),
    };

    validate_template_request(&create_request)?;

    let template_id = state
        .database
        .create_custom_template(&create_request)
        .map_err(|e| AppError::database(format!("导入模板失败: {}", e)))?;

    Ok(template_id)
}

/// 批量导入模板
#[tauri::command]
pub async fn import_custom_templates_bulk(
    request: TemplateBulkImportRequest,
    state: State<'_, AppState>,
) -> Result<String> {
    let parsed: serde_json::Value = serde_json::from_str(&request.template_data)
        .map_err(|e| AppError::validation(format!("解析模板数据失败: {}", e)))?;

    let template_values = match parsed {
        serde_json::Value::Array(items) => items,
        serde_json::Value::Object(_) => vec![parsed],
        _ => {
            return Err(AppError::validation("模板数据必须是对象或数组".to_string()));
        }
    };

    if request.strict_builtin {
        let existing_templates = state
            .database
            .get_all_custom_templates()
            .map_err(|e| AppError::database(format!("查询现有模板失败: {}", e)))?;
        let mut existing_ids: HashSet<String> =
            existing_templates.iter().map(|t| t.id.clone()).collect();
        let mut existing_by_name: HashMap<String, String> = existing_templates
            .iter()
            .map(|template| (template.name.clone(), template.id.clone()))
            .collect();

        let mut imported = 0;
        let mut skipped = 0;
        let mut errors = Vec::new();
        let mut conflicts = Vec::new();

        for template_value in template_values {
            let template_id = template_value
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown");
            let template_name = template_value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名模板");

            if let Some(existing_id) = existing_by_name.get(template_name).cloned() {
                if !request.overwrite_existing {
                    skipped += 1;
                    conflicts.push(template_name.to_string());
                    continue;
                }
                if let Err(e) = state.database.delete_custom_template(&existing_id) {
                    errors.push(format!("{}: {}", template_name, e));
                    continue;
                }
                existing_by_name.remove(template_name);
                existing_ids.remove(&existing_id);
            }

            if existing_ids.contains(template_id) {
                if !request.overwrite_existing {
                    skipped += 1;
                    conflicts.push(template_name.to_string());
                    continue;
                }
                if let Err(e) = state.database.delete_custom_template(template_id) {
                    errors.push(format!("{}: {}", template_name, e));
                    continue;
                }
                existing_ids.remove(template_id);
                existing_by_name.retain(|_, id| id != template_id);
            }

            let fields: Vec<String> = template_value
                .get("fields_json")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            let field_extraction_rules: std::collections::HashMap<
                String,
                crate::models::FieldExtractionRule,
            > = template_value
                .get("field_extraction_rules_json")
                .and_then(|v| v.as_str())
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            let create_request = CreateTemplateRequest {
                name: template_name.to_string(),
                description: template_value
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                author: Some(
                    template_value
                        .get("author")
                        .and_then(|v| v.as_str())
                        .unwrap_or("Anki Design")
                        .to_string(),
                ),
                version: template_value
                    .get("version")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                preview_front: template_value
                    .get("preview_front")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                preview_back: template_value
                    .get("preview_back")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                note_type: template_value
                    .get("note_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Basic")
                    .to_string(),
                fields,
                generation_prompt: template_value
                    .get("generation_prompt")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                front_template: template_value
                    .get("front_template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                back_template: template_value
                    .get("back_template")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                css_style: template_value
                    .get("css_style")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                field_extraction_rules,
                preview_data_json: template_value
                    .get("preview_data_json")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                is_active: Some(true),
                is_built_in: Some(true),
            };

            if let Err(e) = validate_template_request(&create_request) {
                errors.push(format!("{}: {}", template_name, e));
                continue;
            }

            match state
                .database
                .create_custom_template_with_id(template_id, &create_request)
            {
                Ok(_) => {
                    imported += 1;
                    existing_ids.insert(template_id.to_string());
                }
                Err(e) => errors.push(format!("{}: {}", template_name, e)),
            }
        }

        let result = format!(
            "导入完成: {} 个成功, {} 个跳过(已存在){}{}",
            imported,
            skipped,
            if conflicts.is_empty() {
                String::new()
            } else {
                format!(
                    ", {} 个冲突(已跳过): {}。请启用覆盖或修改名称后重试",
                    conflicts.len(),
                    conflicts.join("; ")
                )
            },
            if errors.is_empty() {
                String::new()
            } else {
                format!(", {} 个失败: {}", errors.len(), errors.join("; "))
            }
        );

        return Ok(result);
    }

    let existing_templates = state
        .database
        .get_all_custom_templates()
        .map_err(|e| AppError::database(format!("查询现有模板失败: {}", e)))?;
    let mut existing_by_name: HashMap<String, String> = existing_templates
        .iter()
        .map(|template| (template.name.clone(), template.id.clone()))
        .collect();

    let mut imported = 0;
    let mut skipped = 0;
    let mut errors = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();

    for template_value in template_values {
        let template: CustomAnkiTemplate = match serde_json::from_value(template_value) {
            Ok(template) => template,
            Err(e) => {
                errors.push(format!("解析模板数据失败: {}", e));
                continue;
            }
        };

        let template_name = template.name.clone();

        if let Some(existing_id) = existing_by_name.get(&template_name).cloned() {
            if !request.overwrite_existing {
                skipped += 1;
                conflicts.push(template_name.clone());
                continue;
            }
            if let Err(e) = state.database.delete_custom_template(&existing_id) {
                errors.push(format!("{}: {}", template_name, e));
                continue;
            }
            existing_by_name.remove(&template_name);
        }

        let create_request = CreateTemplateRequest {
            name: template.name,
            description: template.description,
            author: template.author,
            version: Some(template.version),
            preview_front: template.preview_front,
            preview_back: template.preview_back,
            note_type: template.note_type,
            fields: template.fields,
            generation_prompt: template.generation_prompt,
            front_template: template.front_template,
            back_template: template.back_template,
            css_style: template.css_style,
            field_extraction_rules: template.field_extraction_rules,
            preview_data_json: template.preview_data_json,
            is_active: Some(template.is_active),
            is_built_in: Some(template.is_built_in),
        };

        if let Err(e) = validate_template_request(&create_request) {
            errors.push(format!("{}: {}", template_name, e));
            continue;
        }

        match state.database.create_custom_template(&create_request) {
            Ok(template_id) => {
                imported += 1;
                existing_by_name.insert(template_name, template_id);
            }
            Err(e) => errors.push(format!("{}: {}", template_name, e)),
        }
    }

    let result = format!(
        "导入完成: {} 个成功, {} 个跳过(已存在){}{}",
        imported,
        skipped,
        if conflicts.is_empty() {
            String::new()
        } else {
            format!(
                ", {} 个冲突(已跳过): {}。请启用覆盖或修改名称后重试",
                conflicts.len(),
                conflicts.join("; ")
            )
        },
        if errors.is_empty() {
            String::new()
        } else {
            format!(", {} 个失败: {}", errors.len(), errors.join("; "))
        }
    );

    Ok(result)
}

/// 导入内置模板
#[tauri::command]
pub async fn import_builtin_templates(state: State<'_, AppState>) -> Result<String> {
    // 嵌入内置模板 JSON
    const BUILTIN_TEMPLATES_JSON: &str = include_str!("data/builtin-templates.json");

    // 解析模板数组
    let templates: Vec<serde_json::Value> = serde_json::from_str(BUILTIN_TEMPLATES_JSON)
        .map_err(|e| AppError::validation(format!("解析内置模板 JSON 失败: {}", e)))?;

    let mut imported = 0;
    let mut updated = 0;
    let mut skipped = 0;
    let mut errors: Vec<String> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();

    // 获取现有模板列表
    let existing_templates = state
        .database
        .get_all_custom_templates()
        .map_err(|e| AppError::database(format!("查询现有模板失败: {}", e)))?;
    let mut existing_by_id: HashMap<String, CustomAnkiTemplate> = existing_templates
        .iter()
        .map(|t| (t.id.clone(), t.clone()))
        .collect();
    let mut existing_names: HashSet<String> =
        existing_templates.iter().map(|t| t.name.clone()).collect();

    for template_value in templates {
        let template_id = template_value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown");
        let template_name = template_value
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("未命名模板");
        let builtin_version = template_value
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("1.0.0");

        if let Some(existing) = existing_by_id.get(template_id).cloned() {
            if !existing.is_built_in {
                skipped += 1;
                conflicts.push(format!(
                    "{}(ID {} 已被非内置模板占用)",
                    template_name, template_id
                ));
                continue;
            }

            if should_update_builtin_template(&existing.version, builtin_version) {
                let fields: Vec<String> = template_value
                    .get("fields_json")
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                let field_extraction_rules: std::collections::HashMap<
                    String,
                    crate::models::FieldExtractionRule,
                > = template_value
                    .get("field_extraction_rules_json")
                    .and_then(|v| v.as_str())
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                let update_request = UpdateTemplateRequest {
                    name: Some(template_name.to_string()),
                    description: Some(
                        template_value
                            .get("description")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    author: Some(
                        template_value
                            .get("author")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Anki Design")
                            .to_string(),
                    ),
                    version: Some(builtin_version.to_string()),
                    expected_version: Some(existing.version.clone()),
                    preview_front: Some(
                        template_value
                            .get("preview_front")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    preview_back: Some(
                        template_value
                            .get("preview_back")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    note_type: Some(
                        template_value
                            .get("note_type")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Basic")
                            .to_string(),
                    ),
                    fields: Some(fields),
                    generation_prompt: Some(
                        template_value
                            .get("generation_prompt")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    front_template: Some(
                        template_value
                            .get("front_template")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    back_template: Some(
                        template_value
                            .get("back_template")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    css_style: Some(
                        template_value
                            .get("css_style")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                    ),
                    field_extraction_rules: Some(field_extraction_rules),
                    is_active: Some(true),
                    preview_data_json: template_value
                        .get("preview_data_json")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string()),
                    is_built_in: Some(true),
                };

                let merged_request = build_template_request_for_update(&existing, &update_request);
                if let Err(e) = validate_template_request(&merged_request) {
                    errors.push(format!("{}: {}", template_name, e));
                    continue;
                }

                match state
                    .database
                    .update_custom_template(template_id, &update_request)
                {
                    Ok(_) => {
                        updated += 1;
                        let mut new_existing = existing.clone();
                        new_existing.version = builtin_version.to_string();
                        new_existing.name = template_name.to_string();
                        existing_by_id.insert(template_id.to_string(), new_existing);
                    }
                    Err(e) => errors.push(format!("{}: {}", template_name, e)),
                }
            } else {
                skipped += 1;
            }
            continue;
        }

        if existing_names.contains(template_name) {
            skipped += 1;
            conflicts.push(template_name.to_string());
            continue;
        }

        // 解析字段
        let fields: Vec<String> = template_value
            .get("fields_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        // 解析字段提取规则
        let field_extraction_rules: std::collections::HashMap<
            String,
            crate::models::FieldExtractionRule,
        > = template_value
            .get("field_extraction_rules_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let create_request = CreateTemplateRequest {
            name: template_name.to_string(),
            description: template_value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            author: Some(
                template_value
                    .get("author")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Anki Design")
                    .to_string(),
            ),
            version: template_value
                .get("version")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            preview_front: template_value
                .get("preview_front")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            preview_back: template_value
                .get("preview_back")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            note_type: template_value
                .get("note_type")
                .and_then(|v| v.as_str())
                .unwrap_or("Basic")
                .to_string(),
            fields,
            generation_prompt: template_value
                .get("generation_prompt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            front_template: template_value
                .get("front_template")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            back_template: template_value
                .get("back_template")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            css_style: template_value
                .get("css_style")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            field_extraction_rules,
            preview_data_json: template_value
                .get("preview_data_json")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            is_active: Some(true),
            is_built_in: Some(true),
        };

        // 使用指定 ID 创建模板
        match state
            .database
            .create_custom_template_with_id(template_id, &create_request)
        {
            Ok(_) => {
                imported += 1;
                existing_names.insert(template_name.to_string());
            }
            Err(e) => errors.push(format!("{}: {}", template_name, e)),
        }
    }

    let result = format!(
        "导入完成: {} 个新增, {} 个更新, {} 个跳过{}{}",
        imported,
        updated,
        skipped,
        if conflicts.is_empty() {
            String::new()
        } else {
            format!(
                ", {} 个冲突(已跳过): {}。请先删除重名模板或修改名称后重试",
                conflicts.len(),
                conflicts.join("; ")
            )
        },
        if errors.is_empty() {
            String::new()
        } else {
            format!(", {} 个失败: {}", errors.len(), errors.join("; "))
        }
    );

    Ok(result)
}

fn should_update_builtin_template(existing_version: &str, builtin_version: &str) -> bool {
    compare_template_version(existing_version, builtin_version) == Ordering::Less
}

fn compare_template_version(existing_version: &str, builtin_version: &str) -> Ordering {
    let existing = parse_version_parts(existing_version);
    let builtin = parse_version_parts(builtin_version);
    match (existing, builtin) {
        (Some(existing_parts), Some(builtin_parts)) => {
            compare_version_parts(&existing_parts, &builtin_parts)
        }
        (None, Some(_)) => {
            if existing_version == builtin_version {
                Ordering::Equal
            } else {
                Ordering::Less
            }
        }
        (Some(_), None) => Ordering::Equal,
        (None, None) => existing_version.cmp(builtin_version),
    }
}

fn compare_version_parts(existing: &[u64], builtin: &[u64]) -> Ordering {
    let max_len = existing.len().max(builtin.len());
    for idx in 0..max_len {
        let left = *existing.get(idx).unwrap_or(&0);
        let right = *builtin.get(idx).unwrap_or(&0);
        match left.cmp(&right) {
            Ordering::Equal => continue,
            non_eq => return non_eq,
        }
    }
    Ordering::Equal
}

fn parse_version_parts(version: &str) -> Option<Vec<u64>> {
    let trimmed = version.trim();
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = Vec::new();
    for segment in trimmed.split('.') {
        if segment.is_empty() {
            return None;
        }
        let digits: String = segment.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return None;
        }
        let value = digits.parse::<u64>().ok()?;
        parts.push(value);
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts)
    }
}

#[cfg(test)]
mod tests {
    use super::{compare_template_version, should_update_builtin_template};
    use std::cmp::Ordering;

    #[test]
    fn compare_template_version_handles_semver_like_versions() {
        assert_eq!(compare_template_version("2.1.0", "2.1.1"), Ordering::Less);
        assert_eq!(compare_template_version("2.1.1", "2.1.1"), Ordering::Equal);
        assert_eq!(
            compare_template_version("2.2.0", "2.1.9"),
            Ordering::Greater
        );
        assert_eq!(compare_template_version("2.1", "2.1.0"), Ordering::Equal);
    }

    #[test]
    fn compare_template_version_tolerates_non_standard_versions() {
        assert!(should_update_builtin_template("legacy", "2.0.0"));
        assert!(!should_update_builtin_template("2.1.0", "beta"));
    }
}

fn build_template_request_for_update(
    existing: &CustomAnkiTemplate,
    request: &UpdateTemplateRequest,
) -> CreateTemplateRequest {
    CreateTemplateRequest {
        name: request
            .name
            .clone()
            .unwrap_or_else(|| existing.name.clone()),
        description: request
            .description
            .clone()
            .unwrap_or_else(|| existing.description.clone()),
        author: request.author.clone().or_else(|| existing.author.clone()),
        version: request
            .version
            .clone()
            .or_else(|| Some(existing.version.clone())),
        preview_front: request
            .preview_front
            .clone()
            .unwrap_or_else(|| existing.preview_front.clone()),
        preview_back: request
            .preview_back
            .clone()
            .unwrap_or_else(|| existing.preview_back.clone()),
        note_type: request
            .note_type
            .clone()
            .unwrap_or_else(|| existing.note_type.clone()),
        fields: request
            .fields
            .clone()
            .unwrap_or_else(|| existing.fields.clone()),
        generation_prompt: request
            .generation_prompt
            .clone()
            .unwrap_or_else(|| existing.generation_prompt.clone()),
        front_template: request
            .front_template
            .clone()
            .unwrap_or_else(|| existing.front_template.clone()),
        back_template: request
            .back_template
            .clone()
            .unwrap_or_else(|| existing.back_template.clone()),
        css_style: request
            .css_style
            .clone()
            .unwrap_or_else(|| existing.css_style.clone()),
        field_extraction_rules: request
            .field_extraction_rules
            .clone()
            .unwrap_or_else(|| existing.field_extraction_rules.clone()),
        preview_data_json: request
            .preview_data_json
            .clone()
            .or_else(|| existing.preview_data_json.clone()),
        is_active: Some(request.is_active.unwrap_or(existing.is_active)),
        is_built_in: Some(request.is_built_in.unwrap_or(existing.is_built_in)),
    }
}

/// 验证模板请求数据
pub fn validate_template_request(request: &CreateTemplateRequest) -> Result<()> {
    // 验证基本字段
    if request.name.trim().is_empty() {
        return Err(AppError::validation("模板名称不能为空".to_string()));
    }

    if request.fields.is_empty() {
        return Err(AppError::validation("模板必须至少包含一个字段".to_string()));
    }

    // 放宽字段名称限制：不再强制要求 Front/Back 或特定字段名
    // 由模板的 front_template/back_template 与字段提取规则自行约束

    // 验证模板语法
    if request.front_template.trim().is_empty() {
        return Err(AppError::validation("正面模板不能为空".to_string()));
    }

    if request.back_template.trim().is_empty() {
        return Err(AppError::validation("背面模板不能为空".to_string()));
    }

    if request.generation_prompt.trim().is_empty() {
        return Err(AppError::validation("生成提示词不能为空".to_string()));
    }

    // 验证字段提取规则
    for field in &request.fields {
        if !request.field_extraction_rules.contains_key(field) {
            return Err(AppError::validation(format!(
                "缺少字段 '{}' 的提取规则",
                field
            )));
        }
    }

    let field_set: HashSet<&String> = request.fields.iter().collect();
    let extra_rules: Vec<String> = request
        .field_extraction_rules
        .keys()
        .filter(|key| !field_set.contains(key))
        .cloned()
        .collect();
    if !extra_rules.is_empty() {
        return Err(AppError::validation(format!(
            "字段提取规则包含未定义字段: {}",
            extra_rules.join(", ")
        )));
    }

    Ok(())
}

/// 设置默认模板
#[tauri::command]
pub async fn set_default_template(
    template_id: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    Ok(state.database.set_default_template(&template_id)?)
}

/// 获取默认模板ID
#[tauri::command]
pub async fn get_default_template_id(state: tauri::State<'_, AppState>) -> Result<Option<String>> {
    Ok(state.database.get_default_template()?)
}
// ============= 测试日志相关命令 =============

/// 保存测试日志到文件
#[tauri::command]
pub async fn save_test_log(
    file_name: String,
    content: String,
    log_type: String,
    state: tauri::State<'_, AppState>,
) -> Result<()> {
    use std::fs;

    // 创建日志目录路径
    let mut log_dir = state.file_manager.get_app_data_dir().to_path_buf();
    log_dir.push("logs");
    log_dir.push(&log_type);

    // 确保目录存在
    if let Err(e) = fs::create_dir_all(&log_dir) {
        return Err(AppError::file_system(format!("创建日志目录失败: {}", e)));
    }

    // 构建完整文件路径
    let file_path = log_dir.join(&file_name);

    // 写入日志文件
    if let Err(e) = fs::write(&file_path, content) {
        return Err(AppError::file_system(format!("写入日志文件失败: {}", e)));
    }

    debug!("测试日志已保存: {:?}", file_path);
    Ok(())
}
/// 获取测试日志列表
#[tauri::command]
pub async fn get_test_logs(
    log_type: String,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>> {
    use std::fs;

    let mut log_dir = state.file_manager.get_app_data_dir().to_path_buf();
    log_dir.push("logs");
    log_dir.push(&log_type);

    if !log_dir.exists() {
        return Ok(vec![]);
    }

    let mut log_files = Vec::new();

    if let Ok(entries) = fs::read_dir(&log_dir) {
        for entry in entries {
            if let Ok(entry) = entry {
                let path = entry.path();
                if path.is_file() && path.extension().map_or(false, |ext| ext == "log") {
                    if let Some(file_name) = path.file_name() {
                        if let Some(file_name_str) = file_name.to_str() {
                            let relative_path = format!("logs/{}/{}", log_type, file_name_str);
                            log_files.push(relative_path);
                        }
                    }
                }
            }
        }
    }

    // 按修改时间排序（最新的在前）
    log_files.sort_by(|a, b| {
        let path_a = state.file_manager.get_app_data_dir().join(a);
        let path_b = state.file_manager.get_app_data_dir().join(b);

        let time_a = path_a
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        let time_b = path_b
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);

        time_b.cmp(&time_a) // 降序
    });

    Ok(log_files)
}

/// 打开指定的日志文件
#[tauri::command]
pub async fn open_log_file(log_path: String, state: tauri::State<'_, AppState>) -> Result<()> {
    use std::process::Command;

    // 防止路径遍历
    if log_path.contains("..") || log_path.starts_with("/") || log_path.starts_with("\\") {
        return Err(AppError::validation("非法的文件路径"));
    }

    let full_path = state.file_manager.get_app_data_dir().join(&log_path);

    // 规范化路径并检查前缀
    let canonical_path = full_path
        .canonicalize()
        .map_err(|_| AppError::not_found(format!("日志文件不存在: {}", log_path)))?;
    let app_data_dir = state
        .file_manager
        .get_app_data_dir()
        .canonicalize()
        .unwrap_or_else(|_| state.file_manager.get_app_data_dir().to_path_buf());

    if !canonical_path.starts_with(&app_data_dir) {
        return Err(AppError::validation("非法的文件路径访问"));
    }

    // 根据操作系统选择合适的命令打开文件（使用规范化路径）
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = Command::new("notepad").arg(&canonical_path).spawn() {
            // 如果notepad失败，尝试默认程序
            if let Err(e2) = Command::new("cmd")
                .args(&["/C", "start", "", canonical_path.to_str().unwrap_or("")])
                .spawn()
            {
                return Err(AppError::file_system(format!(
                    "打开日志文件失败: {} (备用方案也失败: {})",
                    e, e2
                )));
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Err(e) = Command::new("open").arg(&canonical_path).spawn() {
            return Err(AppError::file_system(format!("打开日志文件失败: {}", e)));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Err(e) = Command::new("xdg-open").arg(&canonical_path).spawn() {
            return Err(AppError::file_system(format!("打开日志文件失败: {}", e)));
        }
    }

    Ok(())
}
/// 打开日志文件夹
#[tauri::command]
pub async fn open_logs_folder(log_type: String, state: tauri::State<'_, AppState>) -> Result<()> {
    use std::process::Command;

    // 防止路径遍历
    if log_type.contains("..") || log_type.starts_with("/") || log_type.starts_with("\\") {
        return Err(AppError::validation("非法的文件路径"));
    }

    let mut log_dir = state.file_manager.get_app_data_dir().to_path_buf();
    log_dir.push("logs");
    log_dir.push(&log_type);

    // 规范化路径并检查前缀
    let canonical_path = if log_dir.exists() {
        log_dir
            .canonicalize()
            .map_err(|_| AppError::not_found("日志目录路径无效"))?
    } else {
        // 如果目录不存在，我们先不canonicalize，而是检查其逻辑路径
        // 但为了安全，我们最好先创建它，然后再 canonicalize
        std::fs::create_dir_all(&log_dir)
            .map_err(|_| AppError::file_system("创建日志目录失败".to_string()))?;
        log_dir
            .canonicalize()
            .map_err(|_| AppError::not_found("日志目录路径无效"))?
    };

    let app_data_dir = state
        .file_manager
        .get_app_data_dir()
        .canonicalize()
        .unwrap_or_else(|_| state.file_manager.get_app_data_dir().to_path_buf());

    if !canonical_path.starts_with(&app_data_dir) {
        return Err(AppError::validation("非法的文件路径访问"));
    }

    // 使用规范化后的路径
    let target_dir = canonical_path;

    // 根据操作系统选择合适的命令打开文件夹
    #[cfg(target_os = "windows")]
    {
        if let Err(e) = Command::new("explorer").arg(&target_dir).spawn() {
            return Err(AppError::file_system(format!("打开日志文件夹失败: {}", e)));
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Err(e) = Command::new("open").arg(&target_dir).spawn() {
            return Err(AppError::file_system(format!("打开日志文件夹失败: {}", e)));
        }
    }

    #[cfg(target_os = "linux")]
    {
        if let Err(e) = Command::new("xdg-open").arg(&target_dir).spawn() {
            return Err(AppError::file_system(format!("打开日志文件夹失败: {}", e)));
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct FrontendLogPayload {
    pub level: Option<String>,
    pub message: String,
    pub stack: Option<String>,
    pub component: Option<String>,
    pub route: Option<String>,
    pub url: Option<String>,
    pub line: Option<u32>,
    pub column: Option<u32>,
    pub user_agent: Option<String>,
    pub extra: Option<serde_json::Value>,
    pub kind: Option<String>,
}

impl FrontendLogPayload {
    fn to_level(&self) -> crate::debug_logger::LogLevel {
        match self
            .level
            .as_deref()
            .map(|v| v.to_ascii_uppercase())
            .as_deref()
        {
            Some("DEBUG") => crate::debug_logger::LogLevel::DEBUG,
            Some("INFO") => crate::debug_logger::LogLevel::INFO,
            Some("WARN") | Some("WARNING") => crate::debug_logger::LogLevel::WARN,
            Some("TRACE") => crate::debug_logger::LogLevel::TRACE,
            _ => crate::debug_logger::LogLevel::ERROR,
        }
    }
}

/// 记录前端错误日志
#[tauri::command]
pub async fn report_frontend_log(payload: FrontendLogPayload) -> Result<()> {
    let level = payload.to_level();
    let kind = payload
        .kind
        .clone()
        .unwrap_or_else(|| "CLIENT_ERROR".to_string());

    let data = serde_json::json!({
        "message": payload.message,
        "stack": payload.stack,
        "component": payload.component,
        "route": payload.route,
        "url": payload.url,
        "line": payload.line,
        "column": payload.column,
        "user_agent": payload.user_agent,
        "extra": payload.extra,
    });

    if let Some(logger) = crate::debug_logger::get_global_logger() {
        logger.log(level, "FRONTEND", &kind, data, None).await;
        Ok(())
    } else {
        Err(AppError::internal("前端日志记录器未初始化"))
    }
}
// set_current_subject 已删除 - 使用 SubjectRouter 代替

#[tauri::command]
pub async fn export_unified_backup_data(
    options: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    // 解析选项
    let _include_images = options
        .get("include_images")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let _include_embeddings = options
        .get("include_embeddings")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include_settings = options
        .get("include_settings")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let _include_stats = options
        .get("include_statistics")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // 回顾分析功能已移除

    // 导出系统设置
    let mut system_settings = serde_json::Map::new();
    if include_settings {
        let conn = state
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("读取设置失败: {}", e)))?;
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings")
            .map_err(|e| AppError::database(format!("读取设置失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::database(format!("读取设置失败: {}", e)))?;
        for row in rows {
            let (k, v) = row.map_err(|e| AppError::database(format!("读取设置失败: {}", e)))?;
            system_settings.insert(k, serde_json::Value::String(v));
        }
    }

    // 导出API配置、模型分配
    let mut api_configs = Vec::new();
    let mut model_assignments = None;
    if include_settings {
        // 获取 API 配置
        api_configs = state
            .llm_manager
            .get_api_configs()
            .await
            .map_err(|e| AppError::database(format!("导出API配置失败: {}", e)))?;

        // 获取模型分配并包装为 Option
        model_assignments = Some(
            state
                .llm_manager
                .get_model_assignments()
                .await
                .map_err(|e| AppError::database(format!("导出模型分配失败: {}", e)))?,
        );
    }

    // 构建元数据
    let mut metadata = serde_json::Map::new();
    metadata.insert("export_options".to_string(), options.clone());

    // 构建返回结果
    let result = serde_json::json!({
        "version": "3.0",
        "timestamp": chrono::Utc::now().to_rfc3339(),
        "backup_type": "unified",
        "traditional_data": {
            "reviews": Vec::<serde_json::Value>::new(),
            "settings": {
                "system_settings": serde_json::Value::Object(system_settings),
                "api_configurations": api_configs,
                "model_assignments": model_assignments
            }
        },
        "metadata": metadata
    });

    Ok(result)
}

// ========== 统计计算辅助函数 ==========

/// 计算月度趋势数据 - 基于真实数据库查询
async fn calculate_monthly_trend(
    database: &Arc<Database>,
) -> std::result::Result<Vec<serde_json::Value>, String> {
    let conn = database
        .get_conn_safe()
        .map_err(|e| format!("Database lock error: {}", e))?;

    // 查询最近6个月的错题创建数据
    let query = "
        SELECT
            strftime('%Y-%m', created_at) as month,
            COUNT(*) as count
        FROM mistakes
        WHERE created_at >= date('now', '-6 months')
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month ASC
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("SQL prepare error: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let month_str: String = row.get(0)?;
            let count: i64 = row.get(1)?;

            // 转换年-月格式为中文月份
            let month_display = if let Some(month_part) = month_str.split('-').nth(1) {
                format!("{}月", month_part.parse::<u8>().unwrap_or(1))
            } else {
                "未知".to_string()
            };

            Ok(serde_json::json!({
                "month": month_display,
                "count": count
            }))
        })
        .map_err(|e| format!("SQL query error: {}", e))?;

    let mut trend_data = Vec::new();
    for row in rows {
        trend_data.push(row.map_err(|e| format!("Row processing error: {}", e))?);
    }

    // 如果没有数据，返回最近6个月的空数据
    if trend_data.is_empty() {
        let now = chrono::Utc::now();
        for offset in (0..6).rev() {
            let days_offset = 30_i64 * offset as i64;
            let duration =
                chrono::Duration::try_days(days_offset).unwrap_or_else(|| chrono::Duration::zero());
            let month = now - duration;
            trend_data.push(serde_json::json!({
                "month": format!("{}月", month.format("%m").to_string().parse::<u8>().unwrap_or(1)),
                "count": 0
            }));
        }
    }

    Ok(trend_data)
}
/// 计算最近增长率 - 基于真实时间序列数据
async fn calculate_recent_growth(database: &Arc<Database>) -> std::result::Result<f64, String> {
    let conn = database
        .get_conn_safe()
        .map_err(|e| format!("Database lock error: {}", e))?;

    // 查询最近两个月的错题数量
    let query = "
        SELECT
            strftime('%Y-%m', created_at) as month,
            COUNT(*) as count
        FROM mistakes
        WHERE created_at >= date('now', '-2 months')
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month ASC
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("SQL prepare error: {}", e))?;
    let rows = stmt
        .query_map([], |row| {
            let _month: String = row.get(0)?;
            let count: i64 = row.get(1)?;
            Ok(count as f64)
        })
        .map_err(|e| format!("SQL query error: {}", e))?;

    let mut monthly_counts = Vec::new();
    for row in rows {
        monthly_counts.push(row.map_err(|e| format!("Row processing error: {}", e))?);
    }

    // 计算增长率
    let growth_rate = if monthly_counts.len() >= 2 {
        let current_month = monthly_counts[monthly_counts.len() - 1];
        let previous_month = monthly_counts[monthly_counts.len() - 2];

        if previous_month > 0.0 {
            ((current_month - previous_month) / previous_month * 100.0).round()
        } else if current_month > 0.0 {
            100.0 // 从0增加到有数据，认为100%增长
        } else {
            0.0
        }
    } else if monthly_counts.len() == 1 && monthly_counts[0] > 0.0 {
        // 只有一个月的数据，且数据大于0
        100.0
    } else {
        0.0
    };

    Ok(growth_rate)
}

/// 回顾分析功能已移除
#[allow(dead_code)]
async fn calculate_review_analysis_stats(
    _database: &Arc<Database>,
) -> std::result::Result<serde_json::Value, String> {
    let review_stats = serde_json::json!({
        "total_reviews": 0,
        "total_covered_mistakes": 0,
        "average_depth": 0.0,
        "improvement_rate": 0.0,
        "recent_reviews": 0,
        "success_rate": 0.0,
        "timestamp": chrono::Utc::now().to_rfc3339()
    });

    Ok(review_stats)
}
/// 计算统一回顾趋势增长率 - 基于回顾分析创建数据
async fn calculate_review_trend(database: &Arc<Database>) -> std::result::Result<f64, String> {
    let conn = database
        .get_conn_safe()
        .map_err(|e| format!("Database lock error: {}", e))?;

    let query = "
        SELECT
            strftime('%Y-%m', created_at) as month,
            COUNT(*) as reviews
        FROM review_analyses
        WHERE created_at >= date('now', '-2 months')
        GROUP BY strftime('%Y-%m', created_at)
        ORDER BY month ASC
    ";

    let mut stmt = conn
        .prepare(query)
        .map_err(|e| format!("SQL prepare error: {}", e))?;
    let rows = stmt
        .query_map([], |row| Ok(row.get::<_, i64>(1)? as f64))
        .map_err(|e| format!("SQL query error: {}", e))?;

    let mut monthly_counts = Vec::new();
    for row in rows {
        monthly_counts.push(row.map_err(|e| format!("Row processing error: {}", e))?);
    }

    if monthly_counts.len() >= 2 {
        let current = monthly_counts[monthly_counts.len() - 1];
        let previous = monthly_counts[monthly_counts.len() - 2];

        if previous > 0.0 {
            Ok(((current - previous) / previous * 100.0).round())
        } else if current > 0.0 {
            Ok(100.0)
        } else {
            Ok(0.0)
        }
    } else {
        Ok(0.0)
    }
}

/// 计算错题质量评分 - 基于真实的分析数据
async fn calculate_mistake_quality_score(
    database: &Arc<Database>,
) -> std::result::Result<f64, String> {
    let conn = database
        .get_conn_safe()
        .map_err(|e| format!("Database lock error: {}", e))?;

    // 计算质量评分：基于是否有标签、是否有聊天记录、是否有总结等
    let quality_query = "
        SELECT
            COUNT(*) FILTER (WHERE tags != '[]' AND tags != '') as tagged_mistakes,
            COUNT(*) FILTER (WHERE mistake_summary IS NOT NULL AND mistake_summary != '') as summarized_mistakes,
            COUNT(*) FILTER (WHERE user_error_analysis IS NOT NULL AND user_error_analysis != '') as analyzed_mistakes,
            COUNT(*) as total_mistakes,
            (SELECT COUNT(DISTINCT mistake_id) FROM chat_messages) as mistakes_with_chat
        FROM mistakes
    ";

    let mut stmt = conn
        .prepare(quality_query)
        .map_err(|e| format!("SQL prepare error: {}", e))?;
    let (tagged, summarized, analyzed, total, with_chat) = stmt
        .query_row([], |row| {
            Ok((
                row.get::<_, i64>(0)? as f64,
                row.get::<_, i64>(1)? as f64,
                row.get::<_, i64>(2)? as f64,
                row.get::<_, i64>(3)? as f64,
                row.get::<_, i64>(4)? as f64,
            ))
        })
        .map_err(|e| format!("SQL query error: {}", e))?;

    if total > 0.0 {
        // 计算质量评分：标签覆盖率30% + 总结覆盖率25% + 分析覆盖率25% + 聊天覆盖率20%
        let tag_score = (tagged / total) * 3.0;
        let summary_score = (summarized / total) * 2.5;
        let analysis_score = (analyzed / total) * 2.5;
        let chat_score = (with_chat / total) * 2.0;

        let total_score = tag_score + summary_score + analysis_score + chat_score;
        Ok((total_score * 10.0).round() / 10.0) // 保留一位小数
    } else {
        Ok(0.0)
    }
}
// ============= 模板调试相关命令 =============

/// 保存模板调试数据
#[tauri::command]
pub async fn save_template_debug_data(
    debug_data: serde_json::Value,
    state: tauri::State<'_, AppState>,
) -> Result<String> {
    use chrono::Local;
    use std::fs;

    // 创建调试目录
    let mut debug_dir = state.file_manager.get_app_data_dir().to_path_buf();
    debug_dir.push("template_debug");

    // 确保目录存在
    if let Err(e) = fs::create_dir_all(&debug_dir) {
        return Err(AppError::file_system(format!("创建调试目录失败: {}", e)));
    }

    // 生成文件名（带时间戳）
    let timestamp = Local::now().format("%Y%m%d_%H%M%S");
    let file_name = format!("template_debug_{}.json", timestamp);
    let file_path = debug_dir.join(&file_name);

    // 美化JSON
    let pretty_json = serde_json::to_string_pretty(&debug_data)
        .map_err(|e| AppError::validation(format!("JSON格式化失败: {}", e)))?;

    // 写入文件
    if let Err(e) = fs::write(&file_path, &pretty_json) {
        return Err(AppError::file_system(format!("写入调试文件失败: {}", e)));
    }

    debug!("模板调试数据已保存: {:?}", file_path);

    // 返回完整路径
    Ok(file_path.to_string_lossy().to_string())
}

// ================================
// 向量索引管理命令
// ================================

/// 优化 Lance 数据库
#[tauri::command]
pub async fn optimize_lance_database(
    _state: State<'_, AppState>,
    _parallelism: Option<usize>,
    _force: Option<bool>,
) -> Result<serde_json::Value> {
    Ok(serde_json::json!({
        "success": true,
        "optimized_tables": 0,
        "duration_ms": 0,
        "message": "Lance 优化已跳过"
    }))
}

/// 获取注入预算配置
#[tauri::command]
pub async fn get_injection_budget_config(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use crate::injection_budget::InjectionBudgetManager;

    let manager = InjectionBudgetManager::from_database_config(&state.database)
        .await
        .map_err(|e| format!("加载注入预算配置失败: {}", e))?;

    Ok(serde_json::json!({
        "config": manager.config,
        "default_config": crate::injection_budget::BudgetConfig::default()
    }))
}
/// 更新注入预算配置
#[tauri::command]
pub async fn simulate_budget_allocation(
    state: State<'_, AppState>,
    test_items: Vec<serde_json::Value>,
) -> Result<serde_json::Value> {
    use crate::injection_budget::{InjectionBudgetManager, InjectionItem, InjectionType, Priority};

    let mut manager = InjectionBudgetManager::from_database_config(&state.database)
        .await
        .map_err(|e| format!("加载配置失败: {}", e))?;

    // 解析测试项目
    for item_json in test_items {
        let injection_type_str = item_json
            .get("type")
            .and_then(|v| v.as_str())
            .ok_or("Missing or invalid 'type' field")?;

        let injection_type = match injection_type_str {
            "rag" => InjectionType::Rag,
            "memory" => InjectionType::Memory,
            "web_search" => InjectionType::WebSearch,
            "context" => InjectionType::Context,
            "system_prompt" => InjectionType::SystemPrompt,
            "user_input" => InjectionType::UserInput,
            "tool_results" => InjectionType::ToolResults,
            _ => return Err(format!("Unknown injection type: {}", injection_type_str).into()),
        };

        let content = item_json
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing or invalid 'content' field")?
            .to_string();

        let priority_str = item_json
            .get("priority")
            .and_then(|v| v.as_str())
            .unwrap_or("medium");

        let priority = match priority_str {
            "critical" => Priority::Critical,
            "high" => Priority::High,
            "medium" => Priority::Medium,
            "low" => Priority::Low,
            "optional" => Priority::Optional,
            _ => Priority::Medium,
        };

        let source = item_json
            .get("source")
            .and_then(|v| v.as_str())
            .unwrap_or("test")
            .to_string();

        let item = InjectionItem::new(injection_type, content, priority, source);
        manager.add_item(item);
    }

    let result = manager.allocate();
    let summary = manager.generate_injection_summary(&result);

    Ok(serde_json::json!({
        "allocation_result": result,
        "summary": summary,
        "total_input_items": manager.pending_items.len(),
        "selected_count": result.selected_items.len(),
        "dropped_count": result.items_dropped.len()
    }))
}

// =====================
// MCP Configuration Management
// =====================

#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn get_mcp_config(state: State<'_, AppState>) -> Result<McpConfig> {
    let database = state.database.clone();
    match crate::load_mcp_config_from_db(&database).await {
        Ok(config) => Ok(config),
        Err(e) => Err(AppError::internal(format!(
            "Failed to load MCP config: {}",
            e
        ))),
    }
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn import_mcp_config(_path: String, _state: State<'_, AppState>) -> Result<McpConfig> {
    // Import functionality removed - no longer supporting external formats
    Err(AppError::validation(
        "Import functionality has been removed",
    ))
}

#[cfg(feature = "mcp")]
#[tauri::command]
pub async fn export_mcp_config(
    _config: McpConfig,
    _format: String,
    _state: State<'_, AppState>,
) -> Result<String> {
    // Export functionality removed - no longer supporting external formats
    Err(AppError::validation(
        "Export functionality has been removed",
    ))
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn get_mcp_config(_state: State<'_, AppState>) -> Result<serde_json::Value> {
    Err(AppError::not_implemented("MCP 功能未在当前构建中启用"))
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn import_mcp_config(
    _path: String,
    _state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    Err(AppError::not_implemented("MCP 功能未在当前构建中启用"))
}

#[cfg(not(feature = "mcp"))]
#[tauri::command]
pub async fn export_mcp_config(
    _config: serde_json::Value,
    _format: String,
    _state: State<'_, AppState>,
) -> Result<String> {
    Err(AppError::not_implemented("MCP 功能未在当前构建中启用"))
}
/// 恢复用：获取最近的文档任务（按更新时间倒序）
#[tauri::command]
pub async fn get_recent_document_tasks(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::DocumentTask>> {
    let lim = limit.unwrap_or(20);
    state
        .database
        .get_recent_document_tasks(lim)
        .map_err(|e| AppError::database(format!("获取最近文档任务失败: {}", e)))
}

/// 恢复用：获取最近生成的卡片（按创建时间倒序）
#[tauri::command]
pub async fn get_all_recent_cards(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::AnkiCard>> {
    let lim = limit.unwrap_or(100);
    state
        .anki_database
        .get_recent_anki_cards(lim)
        .map_err(|e| AppError::database(format!("获取最近卡片失败: {}", e)))
}

// ================= Enhanced Chat Search (FTS + Semantic) =================

// Reports CRUD
#[derive(Debug, serde::Deserialize)]
pub struct ResearchListRequest {
    pub limit: Option<u32>,
}
#[tauri::command]
pub async fn research_list_reports(
    request: ResearchListRequest,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::ResearchReportSummary>> {
    state
        .database
        .list_research_reports(request.limit)
        .map_err(|e| AppError::database(format!("获取研究报告列表失败: {}", e)))
}

#[tauri::command]
pub async fn research_get_report(
    id: String,
    state: State<'_, AppState>,
) -> Result<crate::models::ResearchReport> {
    match state.database.get_research_report(&id) {
        Ok(Some(r)) => Ok(r),
        Ok(None) => Err(AppError::not_found("研究报告不存在")),
        Err(e) => Err(AppError::database(format!("获取研究报告失败: {}", e))),
    }
}

#[tauri::command]
pub async fn research_delete_report(id: String, state: State<'_, AppState>) -> Result<bool> {
    state
        .database
        .delete_research_report(&id)
        .map_err(|e| AppError::database(format!("删除研究报告失败: {}", e)))
}

// 批量导出所有研究报告为ZIP
#[derive(Debug, serde::Deserialize)]
pub struct ResearchExportZipRequest {
    pub format: String,
    pub path: String,
}
#[tauri::command]
pub async fn research_export_all_reports_zip(
    request: ResearchExportZipRequest,
    state: State<'_, AppState>,
) -> Result<String> {
    use std::fs::File;
    use std::io::Write;
    use zip::write::FileOptions;
    use zip::CompressionMethod;
    let format = request.format.to_lowercase();
    if format != "md" && format != "json" {
        return Err(AppError::validation("格式必须为 md 或 json"));
    }
    let list = state
        .database
        .list_research_reports(None)
        .map_err(|e| AppError::database(format!("获取研究报告列表失败: {}", e)))?;
    let path = std::path::Path::new(&request.path);
    let f = File::create(path).map_err(|e| AppError::file_system(e.to_string()))?;
    let mut zip = zip::ZipWriter::new(f);
    let options = FileOptions::default().compression_method(CompressionMethod::Deflated);
    for s in list.into_iter() {
        if let Some(full) = state
            .database
            .get_research_report(&s.id)
            .map_err(|e| AppError::database(e.to_string()))?
        {
            let safe_ts = full
                .created_at
                .to_rfc3339()
                .replace(":", "-")
                .replace("T", "-");
            let subject_val = "通用";
            let base = format!(
                "研究报告-{}-{}",
                subject_val,
                &safe_ts[..std::cmp::min(19, safe_ts.len())]
            );
            if format == "md" {
                let content = format!(
                    "# 科目：{}\n\n- 生成时间：{}\n- 分段数：{}\n- 上下文窗口：{}\n\n---\n\n{}\n",
                    subject_val,
                    full.created_at.to_rfc3339(),
                    full.segments,
                    full.context_window,
                    full.report
                );
                let filename = format!("{}.md", base);
                zip.start_file(filename, options)
                    .map_err(|e| AppError::file_system(e.to_string()))?;
                zip.write_all(content.as_bytes())
                    .map_err(|e| AppError::file_system(e.to_string()))?;
            } else {
                let obj = serde_json::json!({
                    "id": full.id, "subject": "通用", "created_at": full.created_at.to_rfc3339(),
                    "segments": full.segments, "context_window": full.context_window, "report": full.report
                });
                let filename = format!("{}.json", base);
                zip.start_file(filename, options)
                    .map_err(|e| AppError::file_system(e.to_string()))?;
                zip.write_all(
                    serde_json::to_string_pretty(&obj)
                        .unwrap_or_default()
                        .as_bytes(),
                )
                .map_err(|e| AppError::file_system(e.to_string()))?;
            }
        }
    }
    zip.finish()
        .map_err(|e| AppError::file_system(e.to_string()))?;
    Ok(request.path)
}

// =================================================
// 包管理器检测和安装相关命令
// =================================================

#[tauri::command]
pub fn check_package_manager(command: String) -> serde_json::Value {
    use crate::package_manager;

    if let Some(info) = package_manager::detect_required_package_manager(&command) {
        serde_json::json!({
            "detected": true,
            "manager_type": info.manager_type,
            "is_available": info.is_available,
            "version": info.version,
            "install_hints": info.install_hints,
            "can_auto_install": info.install_command.is_some(),
        })
    } else {
        serde_json::json!({
            "detected": false,
            "message": format!("无法识别命令 '{}' 所需的包管理器", command)
        })
    }
}

#[tauri::command]
pub async fn auto_install_package_manager(manager_type: String) -> serde_json::Value {
    use crate::package_manager;

    let result = package_manager::auto_install_package_manager(&manager_type).await;
    serde_json::json!({
        "success": result.success,
        "message": result.message,
        "installed_version": result.installed_version,
    })
}

#[tauri::command]
pub fn check_all_package_managers() -> serde_json::Value {
    use crate::package_manager;

    let node = package_manager::check_node_environment();
    let python = package_manager::check_python_environment();
    let uv = package_manager::check_uv_environment();
    let cargo = package_manager::check_cargo_environment();

    serde_json::json!({
        "node": {
            "is_available": node.is_available,
            "version": node.version,
            "install_hints": node.install_hints,
        },
        "python": {
            "is_available": python.is_available,
            "version": python.version,
            "install_hints": python.install_hints,
        },
        "uv": {
            "is_available": uv.is_available,
            "version": uv.version,
            "install_hints": uv.install_hints,
            "can_auto_install": uv.install_command.is_some(),
        },
        "cargo": {
            "is_available": cargo.is_available,
            "version": cargo.version,
            "install_hints": cargo.install_hints,
            "can_auto_install": cargo.install_command.is_some(),
        },
    })
}

// ==================== 测试数据库管理命令 ====================

/// 切换到测试数据库
/// 将当前数据库连接切换到独立的测试数据库文件
#[tauri::command]
pub async fn switch_to_test_database(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use std::fs;

    let file_manager = &state.file_manager;
    let writable_dir = file_manager.get_writable_app_data_dir();
    let test_db_path = writable_dir.join("test_mistakes.db");

    // 创建测试数据库目录（如果不存在）
    if let Some(parent) = test_db_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| AppError::file_system(format!("创建测试数据库目录失败: {}", e)))?;
    }

    // 初始化测试数据库（如果不存在）
    if !test_db_path.exists() {
        let _test_db = Database::new(&test_db_path)
            .map_err(|e| AppError::file_system(format!("初始化测试数据库失败: {}", e)))?;
        info!("[测试模式] 已创建测试数据库: {:?}", test_db_path);
    } else {
        info!("[测试模式] 使用现有测试数据库: {:?}", test_db_path);
    }

    state
        .database
        .switch_to_path(&test_db_path)
        .map_err(|e| AppError::internal(format!("切换数据库连接失败: {}", e)))?;
    state
        .database_manager
        .switch_database(&test_db_path)
        .map_err(|e| AppError::internal(format!("刷新数据库连接池失败: {}", e)))?;

    {
        let mut guard = state.active_database.write().await;
        *guard = ActiveDatabaseKind::Test;
    }

    Ok(serde_json::json!({
        "success": true,
        "test_db_path": test_db_path.to_string_lossy(),
        "message": "已切换到测试数据库",
        "active_database": ActiveDatabaseKind::Test.as_str(),
    }))
}

/// 重置测试数据库（删除并重新创建）
#[tauri::command]
pub async fn reset_test_database(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use std::fs;

    let file_manager = &state.file_manager;
    let writable_dir = file_manager.get_writable_app_data_dir();
    let test_db_path = writable_dir.join("test_mistakes.db");
    let test_db_wal = writable_dir.join("test_mistakes.db-wal");
    let test_db_shm = writable_dir.join("test_mistakes.db-shm");

    // 删除测试数据库文件（包括WAL和SHM）
    let mut deleted_files = Vec::new();

    if test_db_path.exists() {
        fs::remove_file(&test_db_path)
            .map_err(|e| AppError::file_system(format!("删除测试数据库文件失败: {}", e)))?;
        deleted_files.push(test_db_path.to_string_lossy().to_string());
    }

    if test_db_wal.exists() {
        let _ = fs::remove_file(&test_db_wal);
        deleted_files.push(test_db_wal.to_string_lossy().to_string());
    }

    if test_db_shm.exists() {
        let _ = fs::remove_file(&test_db_shm);
        deleted_files.push(test_db_shm.to_string_lossy().to_string());
    }

    // 重新创建测试数据库
    let _test_db = Database::new(&test_db_path)
        .map_err(|e| AppError::file_system(format!("重新创建测试数据库失败: {}", e)))?;

    info!("[测试模式] 已重置测试数据库: {:?}", test_db_path);

    if matches!(
        *state.active_database.read().await,
        ActiveDatabaseKind::Test
    ) {
        state
            .database
            .switch_to_path(&test_db_path)
            .map_err(|e| AppError::internal(format!("切换数据库连接失败: {}", e)))?;
        state
            .database_manager
            .switch_database(&test_db_path)
            .map_err(|e| AppError::internal(format!("刷新数据库连接池失败: {}", e)))?;
    }

    let active = state.active_database.read().await;

    Ok(serde_json::json!({
        "success": true,
        "test_db_path": test_db_path.to_string_lossy(),
        "deleted_files": deleted_files,
        "message": "测试数据库已重置",
        "active_database": active.as_str(),
    }))
}

/// 切换回生产数据库
#[tauri::command]
pub async fn switch_to_production_database(
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let file_manager = &state.file_manager;
    let production_db_path = file_manager.get_database_path();

    info!("[测试模式] 切换回生产数据库: {:?}", production_db_path);

    state
        .database
        .switch_to_path(&production_db_path)
        .map_err(|e| AppError::internal(format!("切换数据库连接失败: {}", e)))?;
    state
        .database_manager
        .switch_database(&production_db_path)
        .map_err(|e| AppError::internal(format!("刷新数据库连接池失败: {}", e)))?;

    {
        let mut guard = state.active_database.write().await;
        *guard = ActiveDatabaseKind::Production;
    }

    Ok(serde_json::json!({
        "success": true,
        "production_db_path": production_db_path.to_string_lossy(),
        "message": "已切换回生产数据库",
        "active_database": ActiveDatabaseKind::Production.as_str(),
    }))
}

/// 获取当前数据库路径信息
#[tauri::command]
pub async fn get_database_info(state: State<'_, AppState>) -> Result<serde_json::Value> {
    let file_manager = &state.file_manager;
    let production_db_path = file_manager.get_database_path();
    let test_db_path = file_manager
        .get_writable_app_data_dir()
        .join("test_mistakes.db");

    let test_db_exists = test_db_path.exists();

    let active = state.active_database.read().await;

    Ok(serde_json::json!({
        "production_db_path": production_db_path.to_string_lossy(),
        "test_db_path": test_db_path.to_string_lossy(),
        "test_db_exists": test_db_exists,
        "production_db_exists": production_db_path.exists(),
        "active_database": active.as_str(),
    }))
}

/// 播种测试数据库（使用独立模块）
#[tauri::command]
pub async fn seed_test_database(
    config: Option<serde_json::Value>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    use crate::test_utils::database_seed::{seed_test_database as seed_db, SeedConfig};
    use std::sync::Arc;

    // 获取测试数据库路径
    let file_manager = &state.file_manager;
    let writable_dir = file_manager.get_writable_app_data_dir();
    let test_db_path = writable_dir.join("test_mistakes.db");

    // 确保测试数据库存在
    if !test_db_path.exists() {
        let _test_db = Database::new(&test_db_path)
            .map_err(|e| AppError::file_system(format!("初始化测试数据库失败: {}", e)))?;
    }

    // 创建独立的测试数据库实例用于播种
    let test_database = Arc::new(
        Database::new(&test_db_path)
            .map_err(|e| AppError::file_system(format!("打开测试数据库失败: {}", e)))?,
    );

    // 解析配置，默认使用全部选项
    let seed_config = if let Some(cfg) = config {
        SeedConfig {
            create_basic_mistakes: cfg
                .get("create_basic_mistakes")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            create_mistakes_with_chat: cfg
                .get("create_mistakes_with_chat")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            create_mistakes_with_attachments: cfg
                .get("create_mistakes_with_attachments")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
            create_diverse_mistakes: cfg
                .get("create_diverse_mistakes")
                .and_then(|v| v.as_bool())
                .unwrap_or(true),
        }
    } else {
        SeedConfig::default()
    };

    // 播种到测试数据库实例（而非生产数据库）
    let result = seed_db(&test_database, seed_config)?;

    info!(
        "[测试模式] 测试数据库播种完成: 错题{}条, 消息{}条, 数据库: {:?}",
        result.mistakes_created, result.messages_created, test_db_path
    );
    if !result.errors.is_empty() {
        for err in &result.errors {
            error!("[测试模式] 播种错误: {}", err);
        }
    }

    Ok(serde_json::json!({
        "success": true,
        "mistakes_created": result.mistakes_created,
        "messages_created": result.messages_created,
        "errors": result.errors,
        "test_db_path": test_db_path.to_string_lossy(),
    }))
}

/// 检查测试依赖服务健康状态（使用独立模块）
#[tauri::command]
pub async fn check_test_dependencies(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use crate::test_utils::health_check::check_all_dependencies;

    let results = check_all_dependencies(&state.database).await;

    let available = results.iter().all(|r| r.available);
    let details: std::collections::HashMap<String, bool> = results
        .iter()
        .map(|r| (r.service.clone(), r.available))
        .collect();
    let errors: Vec<String> = results.iter().filter_map(|r| r.error.clone()).collect();

    Ok(serde_json::json!({
        "available": available,
        "details": details,
        "errors": errors,
        "results": results,
    }))
}

/// 记录测试运行ID到后端（用于日志关联）
#[tauri::command]
pub async fn set_test_run_id(test_run_id: String) -> Result<serde_json::Value> {
    // 在当前请求上下文中记录testRunId（在实际实现中可以使用上下文或线程本地存储）
    info!("[测试模式] TestRunId设置: {}", test_run_id);

    Ok(serde_json::json!({
        "success": true,
        "test_run_id": test_run_id,
    }))
}

/// 写入测试报告到文件系统
#[tauri::command]
pub async fn write_test_report(
    filename: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    use std::fs;

    let file_manager = &state.file_manager;
    let app_data_dir = file_manager.get_writable_app_data_dir();
    let test_reports_dir = app_data_dir.join("test-reports");

    // 确保目录存在
    fs::create_dir_all(&test_reports_dir)
        .map_err(|e| AppError::file_system(format!("创建测试报告目录失败: {}", e)))?;

    let report_path = test_reports_dir.join(&filename);

    fs::write(&report_path, content)
        .map_err(|e| AppError::file_system(format!("写入测试报告失败: {}", e)))?;

    info!("[测试模式] 测试报告已写入: {:?}", report_path);

    Ok(serde_json::json!({
        "success": true,
        "path": report_path.to_string_lossy(),
        "filename": filename,
    }))
}

// ============================================================================
// 🔧 P0-27 修复：WebView 设置备份/恢复命令
// ============================================================================

/// WebView 设置存储的文件名
const WEBVIEW_SETTINGS_FILE: &str = "webview_settings.json";

/// 保存 WebView localStorage 数据到文件系统
/// 在备份导出前调用此命令，确保 UI 偏好设置被包含在备份中
#[tauri::command]
pub async fn save_webview_settings(
    settings: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    use std::fs;

    let file_manager = &state.file_manager;
    let app_data_dir = file_manager.get_writable_app_data_dir();
    let settings_path = app_data_dir.join(WEBVIEW_SETTINGS_FILE);

    // 序列化并写入
    let content = serde_json::to_string_pretty(&settings)
        .map_err(|e| AppError::validation(format!("序列化 WebView 设置失败: {}", e)))?;

    fs::write(&settings_path, &content)
        .map_err(|e| AppError::file_system(format!("写入 WebView 设置文件失败: {}", e)))?;

    debug!(
        "[P0-27] WebView 设置已保存到: {:?} ({} bytes)",
        settings_path,
        content.len()
    );

    Ok(serde_json::json!({
        "success": true,
        "path": settings_path.to_string_lossy(),
        "size": content.len(),
    }))
}

/// 加载 WebView localStorage 数据从文件系统
/// 在备份恢复后调用此命令，将 UI 偏好设置恢复到前端
#[tauri::command]
pub async fn load_webview_settings(state: State<'_, AppState>) -> Result<serde_json::Value> {
    use std::fs;

    let file_manager = &state.file_manager;
    let app_data_dir = file_manager.get_writable_app_data_dir();
    let settings_path = app_data_dir.join(WEBVIEW_SETTINGS_FILE);

    // 检查文件是否存在
    if !settings_path.exists() {
        debug!("[P0-27] WebView 设置文件不存在: {:?}", settings_path);
        return Ok(serde_json::json!({
            "exists": false,
            "settings": null,
        }));
    }

    // 读取并解析
    let content = fs::read_to_string(&settings_path)
        .map_err(|e| AppError::file_system(format!("读取 WebView 设置文件失败: {}", e)))?;

    let settings: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| AppError::validation(format!("解析 WebView 设置失败: {}", e)))?;

    debug!(
        "[P0-27] WebView 设置已加载: {:?} ({} bytes)",
        settings_path,
        content.len()
    );

    Ok(serde_json::json!({
        "exists": true,
        "settings": settings,
    }))
}

// ============================================================================
// 智能题目集命令（Question Bank V2）
// ============================================================================

use crate::vfs::repos::{
    CreateQuestionParams,
    Question,
    QuestionBankStats,
    QuestionFilters,
    QuestionHistory,
    QuestionListResult,
    QuestionSearchFilters,
    QuestionSearchListResult,
    UpdateQuestionParams,
};

/// 列出题目（分页+筛选）
#[derive(Debug, Clone, Deserialize)]
pub struct ListQuestionsRequest {
    pub exam_id: String,
    #[serde(default)]
    pub filters: Option<QuestionFilters>,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

fn default_page() -> u32 {
    1
}
fn default_page_size() -> u32 {
    50
}

#[tauri::command]
pub async fn qbank_list_questions(
    request: ListQuestionsRequest,
    state: State<'_, AppState>,
) -> Result<QuestionListResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    let filters = request.filters.unwrap_or_default();
    service.list_questions(&request.exam_id, &filters, request.page, request.page_size)
}

// ============================================================================
// FTS5 全文搜索命令
// ============================================================================

/// 全文搜索题目请求
#[derive(Debug, Clone, Deserialize)]
pub struct SearchQuestionsRequest {
    /// 搜索关键词
    pub keyword: String,
    /// 可选，限定题目集 ID
    pub exam_id: Option<String>,
    /// 搜索筛选条件
    #[serde(default)]
    pub filters: Option<QuestionSearchFilters>,
    /// 页码（从 1 开始）
    #[serde(default = "default_page")]
    pub page: u32,
    /// 每页大小（默认 50，最大 100）
    #[serde(default = "default_page_size")]
    pub page_size: u32,
}

/// 全文搜索题目
///
/// 使用 FTS5 全文检索，支持：
/// - 中英文混合搜索
/// - 搜索高亮（返回匹配片段）
/// - 相关性排序（BM25 算法）
/// - 多字段搜索（content, answer, explanation, tags）
#[tauri::command]
pub async fn qbank_search_questions(
    request: SearchQuestionsRequest,
    state: State<'_, AppState>,
) -> Result<QuestionSearchListResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    let filters = request.filters.unwrap_or_default();
    service.search_questions(
        &request.keyword,
        request.exam_id.as_deref(),
        &filters,
        request.page,
        request.page_size,
    )
}

/// 重建 FTS5 索引
///
/// 用于数据修复，重建全文搜索索引
#[tauri::command]
pub async fn qbank_rebuild_fts_index(state: State<'_, AppState>) -> Result<u64> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.rebuild_fts_index()
}

/// 获取单题详情
#[tauri::command]
pub async fn qbank_get_question(
    question_id: String,
    state: State<'_, AppState>,
) -> Result<Option<Question>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_question(&question_id)
}

/// 根据 card_id 获取题目（兼容旧数据）
#[tauri::command]
pub async fn qbank_get_question_by_card_id(
    exam_id: String,
    card_id: String,
    state: State<'_, AppState>,
) -> Result<Option<Question>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_question_by_card_id(&exam_id, &card_id)
}

/// 创建题目
#[tauri::command]
pub async fn qbank_create_question(
    params: CreateQuestionParams,
    state: State<'_, AppState>,
) -> Result<Question> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.create_question(&params)
}

/// 批量创建题目
#[tauri::command]
pub async fn qbank_batch_create_questions(
    params_list: Vec<CreateQuestionParams>,
    state: State<'_, AppState>,
) -> Result<Vec<Question>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.batch_create_questions(&params_list)
}

/// 更新题目
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateQuestionRequest {
    pub question_id: String,
    pub params: UpdateQuestionParams,
    #[serde(default)]
    pub record_history: bool,
}

#[tauri::command]
pub async fn qbank_update_question(
    request: UpdateQuestionRequest,
    state: State<'_, AppState>,
) -> Result<Question> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.update_question(
        &request.question_id,
        &request.params,
        request.record_history,
    )
}

/// 批量更新题目
#[derive(Debug, Clone, Deserialize)]
pub struct BatchUpdateQuestionsRequest {
    pub question_ids: Vec<String>,
    pub params: UpdateQuestionParams,
}

#[tauri::command]
pub async fn qbank_batch_update_questions(
    request: BatchUpdateQuestionsRequest,
    state: State<'_, AppState>,
) -> Result<BatchResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.batch_update_questions(&request.question_ids, &request.params)
}

/// 删除题目
#[tauri::command]
pub async fn qbank_delete_question(question_id: String, state: State<'_, AppState>) -> Result<()> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.delete_question(&question_id)
}

/// 批量删除题目
#[tauri::command]
pub async fn qbank_batch_delete_questions(
    question_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BatchResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.batch_delete_questions(&question_ids)
}

/// 提交答案
#[derive(Debug, Clone, Deserialize)]
pub struct SubmitAnswerRequest {
    pub question_id: String,
    pub user_answer: String,
    #[serde(default)]
    pub is_correct_override: Option<bool>,
}

#[tauri::command]
pub async fn qbank_submit_answer(
    request: SubmitAnswerRequest,
    state: State<'_, AppState>,
) -> Result<SubmitAnswerResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.submit_answer(
        &request.question_id,
        &request.user_answer,
        request.is_correct_override,
    )
}

/// 切换收藏状态
#[tauri::command]
pub async fn qbank_toggle_favorite(
    question_id: String,
    state: State<'_, AppState>,
) -> Result<Question> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.toggle_favorite(&question_id)
}

/// 获取统计
#[tauri::command]
pub async fn qbank_get_stats(
    exam_id: String,
    state: State<'_, AppState>,
) -> Result<Option<QuestionBankStats>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_stats(&exam_id)
}

/// 刷新统计
#[tauri::command]
pub async fn qbank_refresh_stats(
    exam_id: String,
    state: State<'_, AppState>,
) -> Result<QuestionBankStats> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.refresh_stats(&exam_id)
}

/// 获取历史记录
#[tauri::command]
pub async fn qbank_get_history(
    question_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<QuestionHistory>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_history(&question_id, limit)
}

/// 获取作答历史
#[tauri::command]
pub async fn qbank_get_submissions(
    question_id: String,
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<AnswerSubmission>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_submissions(&question_id, limit.unwrap_or(20))
}

/// 重置学习进度
#[tauri::command]
pub async fn qbank_reset_progress(
    exam_id: String,
    state: State<'_, AppState>,
) -> Result<QuestionBankStats> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.reset_progress(&exam_id)
}

/// 按题目 ID 批量重置学习进度
#[tauri::command]
pub async fn qbank_reset_questions_progress(
    question_ids: Vec<String>,
    state: State<'_, AppState>,
) -> Result<BatchResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.reset_questions_progress(&question_ids)
}

// ============================================================================
// 时间维度统计命令（2026-01 新增）
// ============================================================================

use crate::question_bank_service::{
    ActivityHeatmapPoint, KnowledgePoint, KnowledgeStatsComparison, LearningTrendPoint,
};

/// 获取学习趋势数据请求
#[derive(Debug, Clone, Deserialize)]
pub struct GetLearningTrendRequest {
    /// 可选的题目集 ID
    pub exam_id: Option<String>,
    /// 开始日期（YYYY-MM-DD）
    pub start_date: String,
    /// 结束日期（YYYY-MM-DD）
    pub end_date: String,
}

/// 获取学习趋势数据
///
/// 返回指定日期范围内的每日做题数和正确率
#[tauri::command]
pub async fn qbank_get_learning_trend(
    request: GetLearningTrendRequest,
    state: State<'_, AppState>,
) -> Result<Vec<LearningTrendPoint>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_learning_trend(
        request.exam_id.as_deref(),
        &request.start_date,
        &request.end_date,
    )
}

/// 获取活跃度热力图数据请求
#[derive(Debug, Clone, Deserialize)]
pub struct GetActivityHeatmapRequest {
    /// 可选的题目集 ID
    pub exam_id: Option<String>,
    /// 年份
    pub year: i32,
}

/// 获取活跃度热力图数据
///
/// 返回指定年份的每日学习活跃度数据
#[tauri::command]
pub async fn qbank_get_activity_heatmap(
    request: GetActivityHeatmapRequest,
    state: State<'_, AppState>,
) -> Result<Vec<ActivityHeatmapPoint>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_activity_heatmap(request.exam_id.as_deref(), request.year)
}

/// 获取知识点统计请求
#[derive(Debug, Clone, Deserialize)]
pub struct GetKnowledgeStatsRequest {
    /// 可选的题目集 ID
    pub exam_id: Option<String>,
}

/// 获取知识点统计
///
/// 返回各知识点的掌握度统计
#[tauri::command]
pub async fn qbank_get_knowledge_stats(
    request: GetKnowledgeStatsRequest,
    state: State<'_, AppState>,
) -> Result<Vec<KnowledgePoint>> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_knowledge_stats(request.exam_id.as_deref())
}

/// 获取知识点统计（带历史对比）
#[tauri::command]
pub async fn qbank_get_knowledge_stats_with_comparison(
    request: GetKnowledgeStatsRequest,
    state: State<'_, AppState>,
) -> Result<KnowledgeStatsComparison> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_knowledge_stats_with_comparison(request.exam_id.as_deref())
}

// ============================================================================
// 练习模式扩展命令（2026-01 新增）
// ============================================================================

/// 开始限时练习请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StartTimedPracticeRequest {
    pub exam_id: String,
    pub duration_minutes: u32,
    pub question_count: u32,
}

/// 开始限时练习
#[tauri::command]
pub async fn qbank_start_timed_practice(
    request: StartTimedPracticeRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::TimedPracticeSession> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.start_timed_practice(
        &request.exam_id,
        request.duration_minutes,
        request.question_count,
    )
}

/// 生成模拟考试请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateMockExamRequest {
    pub exam_id: String,
    pub config: crate::question_bank_service::MockExamConfig,
}

/// 生成模拟考试
#[tauri::command]
pub async fn qbank_generate_mock_exam(
    request: GenerateMockExamRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::MockExamSession> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.generate_mock_exam(&request.exam_id, request.config)
}

/// 提交模拟考试请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubmitMockExamRequest {
    pub session: crate::question_bank_service::MockExamSession,
}

/// 提交模拟考试
#[tauri::command]
pub async fn qbank_submit_mock_exam(
    request: SubmitMockExamRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::MockExamScoreCard> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.submit_mock_exam(&request.session)
}

/// 获取每日一练请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetDailyPracticeRequest {
    pub exam_id: String,
    pub count: u32,
}

/// 获取每日一练
#[tauri::command]
pub async fn qbank_get_daily_practice(
    request: GetDailyPracticeRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::DailyPracticeResult> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_daily_practice(&request.exam_id, request.count)
}

/// 生成试卷请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratePaperRequest {
    pub exam_id: String,
    pub config: crate::question_bank_service::PaperConfig,
}

/// 生成试卷
#[tauri::command]
pub async fn qbank_generate_paper(
    request: GeneratePaperRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::GeneratedPaper> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.generate_paper(&request.exam_id, request.config)
}

/// 获取打卡日历请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GetCheckInCalendarRequest {
    pub exam_id: Option<String>,
    pub year: i32,
    pub month: u32,
}

/// 获取打卡日历
#[tauri::command]
pub async fn qbank_get_check_in_calendar(
    request: GetCheckInCalendarRequest,
    state: State<'_, AppState>,
) -> Result<crate::question_bank_service::CheckInCalendar> {
    let service = state
        .question_bank_service
        .as_ref()
        .ok_or_else(|| AppError::internal("QuestionBankService not initialized"))?;

    service.get_check_in_calendar(request.exam_id.as_deref(), request.year, request.month)
}

// ============================================================================
// 学习热力图数据聚合
// ============================================================================

/// 单日学习活动详情
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyActivityDetails {
    pub chat_sessions: u32,
    pub chat_messages: u32,
    pub notes_edited: u32,
    pub textbooks_opened: u32,
    pub exams_created: u32,
    pub translations_created: u32,
    pub essays_created: u32,
    pub anki_cards_created: u32,
    pub questions_answered: u32,
}

/// 学习活动数据（热力图单元）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningActivity {
    pub date: String,
    pub count: u32,
    pub details: DailyActivityDetails,
}

/// 获取学习热力图数据
/// 聚合 Chat V2、VFS、Anki 等多个数据源的学习活动
#[tauri::command]
pub async fn get_learning_heatmap(
    start_date: String,
    end_date: String,
    app_handle: AppHandle,
) -> Result<Vec<LearningActivity>> {
    use std::collections::HashMap;

    let mut daily_map: HashMap<String, DailyActivityDetails> = HashMap::new();

    // 初始化日期范围内的所有日期
    let start = chrono::NaiveDate::parse_from_str(&start_date, "%Y-%m-%d")
        .map_err(|e| AppError::validation(format!("Invalid start_date: {}", e)))?;
    let end = chrono::NaiveDate::parse_from_str(&end_date, "%Y-%m-%d")
        .map_err(|e| AppError::validation(format!("Invalid end_date: {}", e)))?;

    let mut current = start;
    while current <= end {
        let date_str = current.format("%Y-%m-%d").to_string();
        daily_map.insert(
            date_str,
            DailyActivityDetails {
                chat_sessions: 0,
                chat_messages: 0,
                notes_edited: 0,
                textbooks_opened: 0,
                exams_created: 0,
                translations_created: 0,
                essays_created: 0,
                anki_cards_created: 0,
                questions_answered: 0,
            },
        );
        current += chrono::Duration::days(1);
    }

    // 辅助函数：执行日期分组查询
    fn query_date_counts(
        conn: &rusqlite::Connection,
        sql: &str,
        start: &str,
        end: &str,
    ) -> Vec<(String, u32)> {
        conn.prepare(sql)
            .and_then(|mut stmt| {
                let rows = stmt.query_map(params![start, end], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
                })?;
                Ok(rows.flatten().collect::<Vec<_>>())
            })
            .unwrap_or_default()
    }

    // 获取 Chat V2 数据库
    if let Some(chat_v2_db) =
        app_handle.try_state::<Arc<crate::chat_v2::database::ChatV2Database>>()
    {
        if let Ok(conn) = chat_v2_db.get_conn() {
            // Chat V2 会话
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(created_at) as date, COUNT(*) as count
                 FROM chat_v2_sessions
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
                 GROUP BY DATE(created_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.chat_sessions = count;
                }
            }

            // Chat V2 消息
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(datetime(timestamp/1000, 'unixepoch')) as date, COUNT(*) as count
                 FROM chat_v2_messages
                 WHERE DATE(datetime(timestamp/1000, 'unixepoch')) >= ?1
                   AND DATE(datetime(timestamp/1000, 'unixepoch')) <= ?2
                 GROUP BY DATE(datetime(timestamp/1000, 'unixepoch'))",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.chat_messages = count;
                }
            }
        }
    }

    // 获取 VFS 数据库
    let state = app_handle.state::<AppState>();
    if let Some(ref vfs_db) = state.vfs_db {
        if let Ok(conn) = vfs_db.get_conn() {
            // VFS 笔记编辑
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(updated_at) as date, COUNT(*) as count
                 FROM notes
                 WHERE deleted_at IS NULL
                   AND DATE(updated_at) >= ?1 AND DATE(updated_at) <= ?2
                 GROUP BY DATE(updated_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.notes_edited = count;
                }
            }

            // VFS 教材打开
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(last_opened_at) as date, COUNT(*) as count
                 FROM files
                 WHERE last_opened_at IS NOT NULL
                   AND DATE(last_opened_at) >= ?1 AND DATE(last_opened_at) <= ?2
                 GROUP BY DATE(last_opened_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.textbooks_opened = count;
                }
            }

            // VFS 整卷识别
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(created_at) as date, COUNT(*) as count
                 FROM exam_sheets
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
                 GROUP BY DATE(created_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.exams_created = count;
                }
            }

            // VFS 翻译
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(created_at) as date, COUNT(*) as count
                 FROM translations
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
                 GROUP BY DATE(created_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.translations_created = count;
                }
            }

            // VFS 作文批改
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(created_at) as date, COUNT(*) as count
                 FROM essays
                 WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
                 GROUP BY DATE(created_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.essays_created = count;
                }
            }

            // VFS 做题记录（question_history）
            for (date, count) in query_date_counts(
                &conn,
                "SELECT DATE(answered_at) as date, COUNT(*) as count
                 FROM question_history
                 WHERE DATE(answered_at) >= ?1 AND DATE(answered_at) <= ?2
                 GROUP BY DATE(answered_at)",
                &start_date,
                &end_date,
            ) {
                if let Some(details) = daily_map.get_mut(&date) {
                    details.questions_answered = count;
                }
            }
        }
    }

    // 获取 Anki 数据库（main.db 中的 anki_cards）
    if let Ok(conn) = state.database.conn().lock() {
        for (date, count) in query_date_counts(
            &conn,
            "SELECT DATE(created_at) as date, COUNT(*) as count
             FROM anki_cards
             WHERE DATE(created_at) >= ?1 AND DATE(created_at) <= ?2
             GROUP BY DATE(created_at)",
            &start_date,
            &end_date,
        ) {
            if let Some(details) = daily_map.get_mut(&date) {
                details.anki_cards_created = count;
            }
        }
    }

    // 转换为结果数组
    let mut result: Vec<LearningActivity> = daily_map
        .into_iter()
        .map(|(date, details)| {
            let count = details.chat_sessions
                + details.chat_messages
                + details.notes_edited
                + details.textbooks_opened
                + details.exams_created
                + details.translations_created
                + details.essays_created
                + details.anki_cards_created
                + details.questions_answered;

            LearningActivity {
                date,
                count,
                details,
            }
        })
        .collect();

    // 按日期排序
    result.sort_by(|a, b| a.date.cmp(&b.date));

    Ok(result)
}

/// M-013: 读取图片为 base64 data URL（供前端 proxyDomURL 使用）
#[tauri::command]
pub async fn get_image_as_base64(
    relative_path: String,
    state: State<'_, AppState>,
) -> Result<String> {
    state.file_manager.get_image_as_base64(&relative_path).await
}

// ============================================================================
// 题目集原始图片管理
// ============================================================================

/// 源图片信息
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceImageInfo {
    pub blob_hash: String,
    pub data_url: String,
    pub page_index: usize,
}

/// 获取题目集的原始导入图片列表（base64 data URL）
#[tauri::command]
pub async fn qbank_get_source_images(
    examId: String,
    state: State<'_, AppState>,
) -> Result<Vec<SourceImageInfo>> {
    use crate::vfs::repos::VfsBlobRepo;

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    // 从 exam_sheet 的 metadata_json 中读取 source_image_hashes
    let exam = crate::vfs::repos::VfsExamRepo::get_exam_sheet(vfs_db, &examId)
        .map_err(|e| AppError::database(format!("获取题目集失败: {}", e)))?
        .ok_or_else(|| AppError::not_found("题目集不存在"))?;

    let mut source_hashes: Vec<String> = exam
        .metadata_json
        .get("source_image_hashes")
        .and_then(|v| serde_json::from_value::<Vec<String>>(v.clone()).ok())
        .unwrap_or_default();

    // ★ 回退：OCR 上传流程不写 source_image_hashes，图片存在 preview_json pages 的 blob_hash 中
    if source_hashes.is_empty() {
        if let Some(pages) = exam.preview_json.get("pages").and_then(|v| v.as_array()) {
            for page in pages {
                if let Some(hash) = page.get("blob_hash").and_then(|v| v.as_str()) {
                    if !hash.is_empty() {
                        source_hashes.push(hash.to_string());
                    }
                }
            }
        }
    }

    if source_hashes.is_empty() {
        return Ok(Vec::new());
    }

    let mut results = Vec::new();
    for (idx, hash) in source_hashes.iter().enumerate() {
        let blob_path = match VfsBlobRepo::get_blob_path(vfs_db, hash) {
            Ok(Some(p)) => p,
            _ => continue,
        };
        let data = match std::fs::read(&blob_path) {
            Ok(d) => d,
            Err(_) => continue,
        };
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        // 检测实际 MIME 类型（通过魔数字节头）
        let mime = if data.starts_with(b"\x89PNG") {
            "image/png"
        } else if data.starts_with(b"\xFF\xD8\xFF") {
            "image/jpeg"
        } else if data.starts_with(b"RIFF") && data.len() > 12 && &data[8..12] == b"WEBP" {
            "image/webp"
        } else {
            "image/png"
        };
        let data_url = format!("data:{};base64,{}", mime, b64);
        results.push(SourceImageInfo {
            blob_hash: hash.clone(),
            data_url,
            page_index: idx,
        });
    }

    Ok(results)
}

/// 裁剪请求参数
#[derive(Debug, Clone, Deserialize)]
pub struct CropSourceImageRequest {
    /// 题目 ID
    pub question_id: String,
    /// 源图片 blob hash
    pub blob_hash: String,
    /// 裁剪区域（相对坐标 0.0~1.0）
    pub crop_x: f64,
    pub crop_y: f64,
    pub crop_width: f64,
    pub crop_height: f64,
}

/// 从原始图片裁剪一个区域，保存为新 blob，添加到题目的 images
#[tauri::command]
pub async fn qbank_crop_source_image(
    request: CropSourceImageRequest,
    state: State<'_, AppState>,
) -> Result<crate::vfs::repos::QuestionImage> {
    use crate::vfs::repos::{QuestionImage, UpdateQuestionParams, VfsBlobRepo, VfsFileRepo, VfsQuestionRepo};

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    // 1. 读取源图片 blob
    let blob_path = VfsBlobRepo::get_blob_path(vfs_db, &request.blob_hash)
        .map_err(|e| AppError::database(format!("获取 Blob 路径失败: {}", e)))?
        .ok_or_else(|| AppError::not_found("源图片 Blob 不存在"))?;

    let img_data = std::fs::read(&blob_path)
        .map_err(|e| AppError::file_system(format!("读取源图片失败: {}", e)))?;

    // 2. 解码图片并裁剪（使用 image::imageops::crop_imm 匹配项目 image 0.24 API）
    let img = image::load_from_memory(&img_data)
        .map_err(|e| AppError::validation(format!("图片解码失败: {}", e)))?;
    let rgba = img.to_rgba8();

    let (w, h) = (rgba.width(), rgba.height());
    let crop_x = (request.crop_x * w as f64).round() as u32;
    let crop_y = (request.crop_y * h as f64).round() as u32;
    let crop_w = (request.crop_width * w as f64).round().max(1.0) as u32;
    let crop_h = (request.crop_height * h as f64).round().max(1.0) as u32;

    // 边界保护
    let crop_x = crop_x.min(w.saturating_sub(1));
    let crop_y = crop_y.min(h.saturating_sub(1));
    let crop_w = crop_w.min(w - crop_x);
    let crop_h = crop_h.min(h - crop_y);

    let crop = image::imageops::crop_imm(&rgba, crop_x, crop_y, crop_w, crop_h);
    let cropped = crop.to_image();

    if cropped.width() == 0 || cropped.height() == 0 {
        return Err(AppError::validation("裁剪区域无效"));
    }

    // 3. 编码为 PNG（写入内存缓冲区）
    let dyn_img = image::DynamicImage::ImageRgba8(cropped);
    let mut cursor = std::io::Cursor::new(Vec::new());
    dyn_img
        .write_to(&mut cursor, image::ImageOutputFormat::Png)
        .map_err(|e| AppError::validation(format!("裁剪图片编码失败: {}", e)))?;
    let buf = cursor.into_inner();

    // 4. 存入 VFS Blob
    let blob = VfsBlobRepo::store_blob(vfs_db, &buf, Some("image/png"), Some("png"))
        .map_err(|e| AppError::database(format!("保存裁剪图片失败: {}", e)))?;

    // 5. ★ BUG-5 修复：创建正式 VFS 文件条目（file_ 前缀），而非无效的 qimg_ 前缀
    //    vfs_get_attachment_content 只接受 att_/file_/tb_ 前缀的 ID
    let file_name = format!("crop_{}.png", &blob.hash[..8]);
    let vfs_file = VfsFileRepo::create_file(
        vfs_db,
        &blob.hash,       // sha256（用于去重）
        &file_name,        // file_name
        buf.len() as i64,  // size
        "image",           // file_type
        Some("image/png"), // mime_type
        Some(&blob.hash),  // blob_hash（链接到 Blob 存储）
        None,              // original_path
    )
    .map_err(|e| AppError::database(format!("创建 VFS 文件条目失败: {}", e)))?;

    // 6. 构建 QuestionImage 并更新题目
    let question_image = QuestionImage {
        id: vfs_file.id.clone(),
        name: file_name,
        mime: "image/png".to_string(),
        hash: blob.hash.clone(),
    };

    // 读取现有题目的 images，追加新图片
    let question = VfsQuestionRepo::get_question(vfs_db, &request.question_id)
        .map_err(|e| AppError::database(format!("获取题目失败: {}", e)))?
        .ok_or_else(|| AppError::not_found("题目不存在"))?;

    let mut images = question.images;
    images.push(question_image.clone());

    let update_params = UpdateQuestionParams {
        images: Some(images),
        ..Default::default()
    };

    VfsQuestionRepo::update_question(vfs_db, &request.question_id, &update_params)
        .map_err(|e| AppError::database(format!("更新题目图片失败: {}", e)))?;

    info!(
        "[QBank] 裁剪图片已添加到题目 {}: file_id={}, blob={}",
        request.question_id, vfs_file.id, blob.hash
    );

    Ok(question_image)
}

/// 删除题目的某张配图
#[tauri::command]
pub async fn qbank_remove_question_image(
    questionId: String,
    imageId: String,
    state: State<'_, AppState>,
) -> Result<()> {
    use crate::vfs::repos::{UpdateQuestionParams, VfsQuestionRepo};

    let vfs_db = state
        .vfs_db
        .as_ref()
        .ok_or_else(|| AppError::validation("VFS 数据库未初始化"))?;

    let question = VfsQuestionRepo::get_question(vfs_db, &questionId)
        .map_err(|e| AppError::database(format!("获取题目失败: {}", e)))?
        .ok_or_else(|| AppError::not_found("题目不存在"))?;

    let images: Vec<_> = question
        .images
        .into_iter()
        .filter(|img| img.id != imageId)
        .collect();

    let update_params = UpdateQuestionParams {
        images: Some(images),
        ..Default::default()
    };

    VfsQuestionRepo::update_question(vfs_db, &questionId, &update_params)
        .map_err(|e| AppError::database(format!("更新题目图片失败: {}", e)))?;

    Ok(())
}
