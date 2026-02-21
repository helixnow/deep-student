//! ChatAnki 工具执行器
//!
//! 支持「纯文本/文件」两种输入，生成可复习的 Anki 卡片，并创建一个 `anki_cards` 预览块。
//!
//! 工具：
//! - `builtin-chatanki_run`：一键执行“文本/文件 → 卡片”全流程（推荐）。
//! - `builtin-chatanki_start`：从已准备好的 content 直接开始制卡（跳过文件解析）。
//! - `builtin-chatanki_status`：查询 documentId 的制卡进度（segments/cards/错误等）。
//! - `builtin-chatanki_wait`：等待 anki_cards 块完成（完成/错误/超时）。
//! - `builtin-chatanki_control`：控制后台任务（暂停/恢复/重试/取消）。
//! - `builtin-chatanki_export`：导出 documentId 的卡片（APKG/JSON）。
//! - `builtin-chatanki_sync`：将 documentId 的卡片同步到 AnkiConnect。
//! - `builtin-chatanki_list_templates`：列出本地可用的制卡模板。
//! - `builtin-chatanki_analyze`：预分析文本，给出 route/密度估计等。
//! - `builtin-chatanki_check_anki_connect`：检查 AnkiConnect 是否可用。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::Connection;
use serde::{Deserialize, Deserializer};
use serde_json::{json, Value};
use tokio::time::{sleep, Duration};

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::resource_types::ContextRef;
use crate::chat_v2::types::{
    block_status, block_types, MessageBlock, MessageRole, ToolCall, ToolResultInfo,
};
use crate::enhanced_anki_service::EnhancedAnkiService;
use crate::llm_manager::ImagePayload;
use crate::models::{
    AnkiDocumentGenerationRequest, AnkiGenerationOptions, CreateTemplateRequest,
    FieldExtractionRule, FieldType,
};
use crate::utils::text::safe_truncate_chars;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsFileRepo, VfsResourceRepo};
use crate::vfs::types::{VfsContextRefData, VfsResourceRef, VfsResourceType};

// ============================================================================
// Args
// ============================================================================

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ChatAnkiTemplateMode {
    Single,
    Multiple,
    All,
}

impl ChatAnkiTemplateMode {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Single => "single",
            Self::Multiple => "multiple",
            Self::All => "all",
        }
    }
}

fn deserialize_optional_i32_flexible<'de, D>(deserializer: D) -> Result<Option<i32>, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Option::<Value>::deserialize(deserializer)?;
    match raw {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => {
            let v = n
                .as_i64()
                .ok_or_else(|| serde::de::Error::custom("maxCards must be an integer"))?;
            i32::try_from(v)
                .map(Some)
                .map_err(|_| serde::de::Error::custom("maxCards out of i32 range"))
        }
        Some(Value::String(s)) => {
            let trimmed = s.trim();
            if trimmed.is_empty() {
                return Ok(None);
            }
            trimmed
                .parse::<i32>()
                .map(Some)
                .map_err(|_| serde::de::Error::custom("maxCards string must be a valid integer"))
        }
        _ => Err(serde::de::Error::custom(
            "maxCards must be integer or numeric string",
        )),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiRunArgs {
    goal: String,
    /// 可选：纯文本/Markdown 输入（无文件也能制卡）
    content: Option<String>,
    route: Option<String>,
    #[serde(alias = "resourceId")]
    resource_id: Option<String>,
    #[serde(alias = "resourceIds")]
    resource_ids: Option<Vec<String>>,
    /// 可选：指定制卡模板（需与 field_extraction_rules/template_fields 匹配）
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: ChatAnkiTemplateMode,
    /// 可选：导出/同步默认牌组
    deck_name: Option<String>,
    /// 可选：导出/同步默认笔记类型
    note_type: Option<String>,
    /// 可选：最大卡片数量（用户指定时覆盖默认值）
    #[serde(
        alias = "maxCards",
        default,
        deserialize_with = "deserialize_optional_i32_flexible"
    )]
    max_cards: Option<i32>,
    debug: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiStartArgs {
    goal: String,
    content: String,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: ChatAnkiTemplateMode,
    deck_name: Option<String>,
    note_type: Option<String>,
    /// 可选：最大卡片数量（用户指定时覆盖默认值）
    #[serde(
        alias = "maxCards",
        default,
        deserialize_with = "deserialize_optional_i32_flexible"
    )]
    max_cards: Option<i32>,
    debug: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiStatusArgs {
    #[serde(alias = "documentId")]
    document_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiWaitArgs {
    /// 可选：anki_cards 预览块 ID（优先用于等待 UI block 完成）
    #[serde(alias = "ankiBlockId")]
    anki_block_id: Option<String>,
    /// 可选：后台文档任务 ID（用于直接轮询 anki_db 的 task 状态）
    #[serde(alias = "documentId")]
    document_id: Option<String>,
    #[serde(alias = "timeoutMs")]
    timeout_ms: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiControlArgs {
    action: String,
    #[serde(alias = "documentId")]
    document_id: String,
    #[serde(alias = "taskId")]
    task_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiExportArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    format: String,
    deck_name: Option<String>,
    note_type: Option<String>,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "suggestedName")]
    suggested_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiSyncArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    deck_name: Option<String>,
    note_type: Option<String>,
    #[serde(alias = "templateId")]
    template_id: Option<String>,
    #[serde(alias = "templateIds")]
    template_ids: Option<Vec<String>>,
    #[serde(alias = "templateMode")]
    template_mode: Option<ChatAnkiTemplateMode>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiListTemplatesArgs {
    category: Option<String>,
    #[serde(alias = "activeOnly")]
    active_only: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatAnkiAnalyzeArgs {
    content: String,
    goal: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ChatAnkiRoute {
    SimpleText,
    VlmLight,
    VlmFull,
}

impl ChatAnkiRoute {
    fn from_str(s: &str) -> Option<Self> {
        match s {
            "simple_text" => Some(Self::SimpleText),
            "vlm_light" => Some(Self::VlmLight),
            "vlm_full" => Some(Self::VlmFull),
            _ => None,
        }
    }

    fn as_str(&self) -> &'static str {
        match self {
            Self::SimpleText => "simple_text",
            Self::VlmLight => "vlm_light",
            Self::VlmFull => "vlm_full",
        }
    }
}

// ============================================================================
// Executor
// ============================================================================

pub struct ChatAnkiToolExecutor;

impl ChatAnkiToolExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 去除工具名前缀
    ///
    /// 支持的前缀：builtin-, mcp_
    fn strip_namespace(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    fn is_chatanki_tool(tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(
            stripped,
            "chatanki_run"
                | "chatanki_start"
                | "chatanki_status"
                | "chatanki_wait"
                | "chatanki_control"
                | "chatanki_export"
                | "chatanki_sync"
                | "chatanki_list_templates"
                | "chatanki_analyze"
                | "chatanki_check_anki_connect"
        )
    }
}

impl Default for ChatAnkiToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for ChatAnkiToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_chatanki_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        log::info!(
            "[ChatAnkiToolExecutor] execute: tool_name={}, tool_call_id={}, session_id={}, message_id={}",
            call.name,
            call.id,
            ctx.session_id,
            ctx.message_id
        );

        // Required: tool_call start event so the UI can render the tool block immediately.
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let stripped_name = Self::strip_namespace(&call.name).to_string();

        match stripped_name.as_str() {
            "chatanki_check_anki_connect" => {
                self.execute_check_anki_connect(call, ctx, start_time).await
            }
            "chatanki_status" => self.execute_status(call, ctx, start_time).await,
            "chatanki_wait" => self.execute_wait(call, ctx, start_time).await,
            "chatanki_control" => self.execute_control(call, ctx, start_time).await,
            "chatanki_export" => self.execute_export(call, ctx, start_time).await,
            "chatanki_sync" => self.execute_sync(call, ctx, start_time).await,
            "chatanki_list_templates" => self.execute_list_templates(call, ctx, start_time).await,
            "chatanki_analyze" => self.execute_analyze(call, ctx, start_time).await,
            "chatanki_start" => self.execute_start(call, ctx, start_time).await,
            "chatanki_run" => self.execute_run(call, ctx, start_time).await,
            _ => Err(format!("Unsupported chatanki tool: {}", stripped_name)),
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::strip_namespace(tool_name) {
            // ★ 2026-02-09: chatanki_export/chatanki_sync 降为 Low
            // 理由：制卡是创建性操作（生成新卡片），非破坏性，不应打断制卡体验流
            "chatanki_export" | "chatanki_sync" => ToolSensitivity::Low,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "ChatAnkiToolExecutor"
    }
}

// ============================================================================
// Tool handlers
// ============================================================================

impl ChatAnkiToolExecutor {
    async fn execute_check_anki_connect(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let (available, error) =
            match crate::anki_connect_service::check_anki_connect_availability().await {
                Ok(v) => (v, None),
                Err(e) => (false, Some(e)),
            };

        let output = json!({
            "status": "ok",
            "available": available,
            "error": error,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_status(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiStatusArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_status arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let document_id = args.document_id.trim().to_string();
        if document_id.is_empty() {
            let error_msg = "documentId is required".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let db = match &ctx.anki_db {
            Some(db) => db,
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let tasks = db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let cards = db
            .get_cards_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let counts = compute_task_counts(&tasks);
        let (status, error, should_retry) = derive_status_snapshot(&tasks, cards.len());

        let output = json!({
            "status": status,
            "documentId": document_id,
            "counts": counts,
            "cardsCount": cards.len(),
            "error": error,
            "shouldRetry": should_retry,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        if output.get("status").and_then(|v| v.as_str()) == Some("not_found") {
            let error_message = output
                .get("error")
                .and_then(|v| v.as_str())
                .unwrap_or("not_found")
                .to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_message, None);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_wait(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiWaitArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_wait arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let chat_db = ctx.chat_v2_db.clone();
        let anki_db = ctx.anki_db.clone();

        const DEFAULT_TIMEOUT_MS: u64 = 30 * 60 * 1000;
        const MAX_TIMEOUT_MS: u64 = 60 * 60 * 1000;
        const BLOCK_DISCOVERY_GRACE_MS: u64 = 8_000;
        const POLL_INTERVAL: Duration = Duration::from_millis(900);

        // Treat timeoutMs=0 as "use default" (some clients may pass 0 by default).
        let timeout_ms = args
            .timeout_ms
            .filter(|v| *v > 0)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .min(MAX_TIMEOUT_MS);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);

        let mut _final_status = "timeout".to_string();
        let mut final_error: Option<String> = None;
        let mut final_anki_block_id: Option<String> = None;
        let mut final_document_id: Option<String> = None;
        let mut final_cards_count: Option<usize> = None;
        let mut final_progress: Option<Value> = None;
        let mut final_anki_connect: Option<Value> = None;
        let mut block_ever_found = false;

        let has_anki_block_id = args
            .anki_block_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();
        let has_document_id = args
            .document_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .is_some();

        if !has_anki_block_id && !has_document_id {
            final_status = "invalid_args".to_string();
            final_error = Some("blocks.ankiCards.errors.waitInvalidArgs".to_string());
            let tool_output = json!({
                "status": final_status,
                "ankiBlockId": "",
                "documentId": null,
                "cardsCount": 0,
                "progress": null,
                "ankiConnect": null,
                "error": final_error,
                "shouldRetry": false,
            });

            let duration_ms = start_time.elapsed().as_millis() as u64;
            let error_message = final_error.clone().unwrap_or_default();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_message, None);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: tool_output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        loop {
            if ctx.is_cancelled() {
                final_status = "cancelled".to_string();
                break;
            }

            // Prefer waiting on documentId (stable, doesn't depend on chat_v2 block persistence).
            if let Some(doc_id) = args
                .document_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                if let Some(db) = &anki_db {
                    let tasks = db
                        .get_tasks_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let cards = db
                        .get_cards_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let counts = compute_task_counts(&tasks);
                    let is_paused = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
                    let is_in_progress = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        )
                    });
                    let has_failed_or_truncated = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Failed
                                | crate::models::TaskStatus::Truncated
                        )
                    });
                    let has_cancelled = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Cancelled));

                    // If tasks don't exist yet, keep waiting (avoid failing fast).
                    if !tasks.is_empty() && !is_in_progress && !is_paused {
                        final_status = if has_cancelled {
                            "cancelled".to_string()
                        } else if has_failed_or_truncated {
                            "completed_with_errors".to_string()
                        } else {
                            "completed".to_string()
                        };
                        final_document_id = Some(doc_id.to_string());
                        final_cards_count = Some(cards.len());
                        final_progress = Some(
                            json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                        );
                        break;
                    }

                    // Progress snapshot for timeout return.
                    final_document_id = Some(doc_id.to_string());
                    final_cards_count = Some(cards.len());
                    final_progress = Some(
                        json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                    );
                } else {
                    // No anki_db; fall back to block-based wait below.
                }
            }

            // Otherwise (or fallback): wait on anki_cards block status.
            if let Some(block_id) = args
                .anki_block_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                // Some user flows may call wait before the preview block is persisted, and the
                // `anki_cards` block may be temporarily deleted/reinserted during pipeline saves.
                // Don't fail fast here; keep polling until the deadline.
                final_anki_block_id = Some(block_id.to_string());

                if let Some(chat_db) = &chat_db {
                    let block_opt =
                        ChatV2Repo::get_block_v2(chat_db, block_id).map_err(|e| e.to_string())?;
                    if let Some(block) = block_opt {
                        block_ever_found = true;
                        final_anki_block_id = Some(block.id.clone());

                        // Best-effort parse progress info from tool_output (may only be present at the end).
                        if let Some(out) = block.tool_output.as_ref() {
                            final_document_id = out
                                .get("documentId")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                                .or(final_document_id);
                            final_progress = out.get("progress").cloned().or(final_progress);
                            final_anki_connect =
                                out.get("ankiConnect").cloned().or(final_anki_connect);
                            if final_cards_count.is_none() {
                                final_cards_count =
                                    out.get("cards").and_then(|v| v.as_array()).map(|a| a.len());
                            }
                        }

                        let status = block.status.clone();
                        if status == block_status::SUCCESS {
                            // If we already know the documentId, try to refine "completed" vs "cancelled/completed_with_errors".
                            if let (Some(db), Some(doc_id)) =
                                (&anki_db, final_document_id.as_deref())
                            {
                                let tasks = db
                                    .get_tasks_for_document(doc_id)
                                    .map_err(|e| e.to_string())?;
                                if !tasks.is_empty() {
                                    let has_failed_or_truncated = tasks.iter().any(|t| {
                                        matches!(
                                            t.status,
                                            crate::models::TaskStatus::Failed
                                                | crate::models::TaskStatus::Truncated
                                        )
                                    });
                                    let has_cancelled = tasks.iter().any(|t| {
                                        matches!(t.status, crate::models::TaskStatus::Cancelled)
                                    });
                                    final_status = if has_cancelled {
                                        "cancelled".to_string()
                                    } else if has_failed_or_truncated {
                                        "completed_with_errors".to_string()
                                    } else {
                                        "completed".to_string()
                                    };
                                } else {
                                    final_status = "completed".to_string();
                                }
                            } else {
                                final_status = "completed".to_string();
                            }
                            break;
                        }
                        if status == block_status::ERROR {
                            final_status = "error".to_string();
                            final_error = block.error.clone().or(final_error);
                            break;
                        }
                    }
                }
            }

            // If caller didn't provide documentId, but we discovered it from the block,
            // we can wait on the task table (more stable than block persistence).
            if args
                .document_id
                .as_deref()
                .map(str::trim)
                .unwrap_or("")
                .is_empty()
            {
                if let (Some(db), Some(doc_id)) = (&anki_db, final_document_id.as_deref()) {
                    let tasks = db
                        .get_tasks_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let cards = db
                        .get_cards_for_document(doc_id)
                        .map_err(|e| e.to_string())?;
                    let counts = compute_task_counts(&tasks);
                    let is_paused = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
                    let is_in_progress = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        )
                    });
                    let has_failed_or_truncated = tasks.iter().any(|t| {
                        matches!(
                            t.status,
                            crate::models::TaskStatus::Failed
                                | crate::models::TaskStatus::Truncated
                        )
                    });
                    let has_cancelled = tasks
                        .iter()
                        .any(|t| matches!(t.status, crate::models::TaskStatus::Cancelled));

                    // If tasks don't exist yet, keep waiting (avoid failing fast).
                    if !tasks.is_empty() && !is_in_progress && !is_paused {
                        final_status = if has_cancelled {
                            "cancelled".to_string()
                        } else if has_failed_or_truncated {
                            "completed_with_errors".to_string()
                        } else {
                            "completed".to_string()
                        };
                        final_document_id = Some(doc_id.to_string());
                        final_cards_count = Some(cards.len());
                        final_progress = Some(
                            json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                        );
                        break;
                    }

                    // Progress snapshot for timeout return.
                    final_cards_count = Some(cards.len());
                    final_progress = Some(
                        json!({ "counts": counts.get("counts").cloned().unwrap_or(json!({})), "completedRatio": counts.get("completedRatio").cloned().unwrap_or(json!(0.0)) }),
                    );
                }
            }

            // 当仅依赖 ankiBlockId 且长时间未发现 block 时，提前返回 not_found，
            // 避免 LLM 同轮误调用 wait 导致整轮阻塞到默认 30 分钟超时。
            if !has_document_id
                && has_anki_block_id
                && !block_ever_found
                && start_time.elapsed().as_millis() as u64 >= BLOCK_DISCOVERY_GRACE_MS
            {
                final_status = "not_found".to_string();
                final_error = Some("blocks.ankiCards.errors.waitNotFound".to_string());
                break;
            }

            // Timeout check after status checks so we still catch a quick completion.
            if Instant::now() >= deadline {
                let document_wait_available = (args
                    .document_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some()
                    || final_document_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_some())
                    && anki_db.is_some();

                let (status, error) = decide_wait_timeout_status(
                    block_ever_found,
                    document_wait_available,
                    timeout_ms,
                );
                final_status = status;
                final_error = error;
                break;
            }

            sleep(POLL_INTERVAL).await;
        }

        if final_status == "timeout" && final_error.is_none() {
            final_error = Some("blocks.ankiCards.errors.waitTimeout".to_string());
        }
        let should_retry = matches!(final_status.as_str(), "timeout" | "not_found");

        // Always return a structured result (avoid tool failure for "not found" / "timeout").
        let tool_output = json!({
            "status": final_status,
            "ankiBlockId": final_anki_block_id.or_else(|| args.anki_block_id.clone()).unwrap_or_default(),
            "documentId": final_document_id,
            "cardsCount": final_cards_count.unwrap_or(0),
            "progress": final_progress,
            "ankiConnect": final_anki_connect,
            "error": final_error,
            "shouldRetry": should_retry,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        if matches!(final_status.as_str(), "invalid_args" | "not_found") {
            let error_message = final_error.clone().unwrap_or_else(|| final_status.clone());
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_message, None);
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output: tool_output,
                success: false,
                error: Some(error_message),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": tool_output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            tool_output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_analyze(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiAnalyzeArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_analyze arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let content = args.content;
        if content.trim().is_empty() {
            let error_msg = "content is required".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let chars = content.chars().count();
        let non_empty_lines: Vec<&str> = content
            .lines()
            .map(|l| l.trim())
            .filter(|l| !l.is_empty())
            .collect();
        let glossary_mode = looks_like_glossary_content(&content);

        // Rough entry estimate for glossary-like content
        let mut entry_like = 0usize;
        for l in &non_empty_lines {
            if l.contains('：') || l.contains(':') || l.starts_with("- ") || l.starts_with("* ") {
                entry_like += 1;
                continue;
            }
            if l.len() >= 3
                && l.chars()
                    .next()
                    .map(|c| c.is_ascii_digit())
                    .unwrap_or(false)
            {
                entry_like += 1;
            }
        }

        let max_output_tokens_override: Value = if glossary_mode {
            Value::from(2400)
        } else {
            Value::Null
        };
        let recommended = json!({
            "route": "simple_text",
            "glossaryMode": glossary_mode,
            "segmentOverlapSize": if glossary_mode { 0 } else { 200 },
            "maxOutputTokensOverride": max_output_tokens_override,
            "temperature": if glossary_mode { 0.2 } else { 0.3 },
        });

        let output = json!({
            "status": "ok",
            "goal": args.goal,
            "metrics": {
                "chars": chars,
                "nonEmptyLines": non_empty_lines.len(),
                "entryLikeLines": entry_like,
            },
            "recommended": recommended,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_list_templates(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiListTemplatesArgs>(call.arguments.clone())
        {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_list_templates arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match ctx.main_db.as_ref().or(ctx.anki_db.as_ref()) {
            Some(db) => db,
            None => {
                let error_msg = "Database not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let active_only = args.active_only.unwrap_or(true);
        let query = args.category.unwrap_or_default().trim().to_lowercase();

        let mut templates = match db.get_all_custom_templates() {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to list templates: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };
        if templates.is_empty() {
            if let Err(e) = import_builtin_templates_if_empty(db) {
                log::warn!(
                    "[ChatAnkiToolExecutor] auto-import builtin templates failed: {}",
                    e
                );
            } else if let Ok(v) = db.get_all_custom_templates() {
                templates = v;
            }
        }

        let mut out: Vec<Value> = Vec::new();
        for t in templates {
            if active_only && !t.is_active {
                continue;
            }
            if !query.is_empty() {
                let hay = format!("{} {}\n{}", t.id, t.name, t.description).to_lowercase();
                if !hay.contains(&query) && !t.note_type.to_lowercase().contains(&query) {
                    continue;
                }
            }
            let fields = normalize_template_fields(&t.fields);
            let rules = ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
            let complexity_level = calculate_complexity_level(fields.len(), &t.note_type);
            let use_case = if t.description.trim().is_empty() {
                t.name.clone()
            } else {
                t.description.clone()
            };
            out.push(json!({
                "id": t.id,
                "name": t.name,
                "description": t.description,
                "category": "general",
                "noteType": t.note_type,
                "fields": fields,
                "isActive": t.is_active,
                "complexityLevel": complexity_level,
                "useCaseDescription": use_case,
                "field_extraction_rules": rules,
                "generation_prompt": t.generation_prompt,
                "isBuiltIn": t.is_built_in,
            }));
        }

        let query_value: Value = if query.is_empty() {
            Value::Null
        } else {
            Value::from(query)
        };
        let output = json!({
            "status": "ok",
            "activeOnly": active_only,
            "query": query_value,
            "count": out.len(),
            "templates": out,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_export(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiExportArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_export arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let cards = match db.get_cards_for_document(&args.document_id) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to load cards for document: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let cards: Vec<crate::models::AnkiCard> =
            cards.into_iter().filter(|c| !c.is_error_card).collect();
        if cards.is_empty() {
            let error_msg = "No cards to export (all cards are empty or error cards)".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }
        let cards_count = cards.len();

        let (deck_name, note_type) =
            resolve_deck_and_note_type(ctx, args.deck_name, args.note_type);
        let format = args.format.trim().to_lowercase();

        let (export_format, export_path, final_note_type) = if format == "json" {
            let suggested = args
                .suggested_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    format!(
                        "{}_chatanki_cards.json",
                        deck_name.replace('/', "_").replace('\\', "_")
                    )
                });

            let json_content = serde_json::to_string_pretty(&cards)
                .map_err(|e| format!("Serialize json failed: {}", e))?;

            let path = crate::cmd::anki_connect::save_json_file(json_content, suggested)
                .await
                .map_err(|e| e.to_string())?;
            ("json".to_string(), path, note_type)
        } else if format == "apkg" {
            let cloze_count = cards
                .iter()
                .filter(|card| card_has_cloze_markup(card))
                .count();
            let all_cloze = cloze_count == cards.len();
            let mut note = note_type;
            if all_cloze && note != "Cloze" {
                note = "Cloze".to_string();
            }

            let suggested = args
                .suggested_name
                .filter(|s| !s.trim().is_empty())
                .unwrap_or_else(|| {
                    format!("{}.apkg", deck_name.replace('/', "_").replace('\\', "_"))
                });
            let suggested = if suggested.to_lowercase().ends_with(".apkg") {
                suggested
            } else {
                format!("{}.apkg", suggested)
            };

            let output_path = if cfg!(any(target_os = "ios", target_os = "android")) {
                std::env::temp_dir().join(&suggested)
            } else {
                let home_dir = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .unwrap_or_else(|_| ".".to_string());
                let downloads_dir = std::path::PathBuf::from(home_dir).join("Downloads");
                match std::fs::create_dir_all(&downloads_dir) {
                    Ok(_) => downloads_dir.join(&suggested),
                    Err(_) => std::env::temp_dir().join(&suggested),
                }
            };

            let explicit_template_id = args
                .template_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let inferred_single_template_id = infer_single_template_id_from_cards(&cards);
            let fallback_template_id = explicit_template_id.or(inferred_single_template_id);
            let mut cards = cards;
            let unresolved_template_cards = cards
                .iter()
                .filter(|card| {
                    card.template_id
                        .as_deref()
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .is_none()
                })
                .count();
            if unresolved_template_cards > 0 {
                if let Some(fallback_id) = fallback_template_id.clone() {
                    for card in &mut cards {
                        if card
                            .template_id
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .is_none()
                        {
                            card.template_id = Some(fallback_id.clone());
                        }
                    }
                } else {
                    let error_msg = "blocks.ankiCards.errors.templateNotFound".to_string();
                    ctx.emitter
                        .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }

            // 收集所有唯一的 template_id，批量加载模板
            let mut unique_template_ids: Vec<String> = Vec::new();
            for card in &cards {
                if let Some(tid) = card
                    .template_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let tid = tid.to_string();
                    if !unique_template_ids.contains(&tid) {
                        unique_template_ids.push(tid);
                    }
                }
            }

            // 加载所有模板
            let mut template_cache: HashMap<String, crate::models::CustomAnkiTemplate> =
                HashMap::new();
            for tid in &unique_template_ids {
                if let Ok(Some(t)) = db.get_custom_template_by_id(tid) {
                    template_cache.insert(tid.clone(), t);
                } else {
                    log::warn!("[chatanki_export] Template not found: {}, cards with this template will use fallback fields", tid);
                }
            }

            // 多模板 APKG 导出：每种 template_id 创建独立的 Anki model，
            // 每张卡片的 notes.mid 指向自己模板对应的 model。
            // Anki 格式支持一个 APKG 内多个 note type（model），字段和 card template 各自独立。
            crate::apkg_exporter_service::export_multi_template_apkg(
                cards,
                deck_name.clone(),
                output_path.clone(),
                template_cache,
            )
            .await
            .map_err(|e| e.to_string())?;

            (
                "apkg".to_string(),
                output_path.to_string_lossy().to_string(),
                note,
            )
        } else {
            let error_msg = format!("Unsupported export format: {}", args.format);
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        };

        let output = json!({
            "status": "ok",
            "documentId": args.document_id,
            "format": export_format,
            "path": export_path,
            "deckName": deck_name,
            "noteType": final_note_type,
            "cardsCount": cards_count,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_sync(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiSyncArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_sync arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let cards = match db.get_cards_for_document(&args.document_id) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Failed to load cards for document: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };
        let cards: Vec<crate::models::AnkiCard> =
            cards.into_iter().filter(|c| !c.is_error_card).collect();
        if cards.is_empty() {
            let error_msg = "No cards to sync (all cards are empty or error cards)".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        // Validate AnkiConnect availability.
        if let Err(e) = crate::anki_connect_service::check_anki_connect_availability().await {
            let error_key = "blocks.ankiCards.errors.ankiConnectUnavailable".to_string();
            log::warn!("[ChatAnkiToolExecutor] AnkiConnect unavailable: {}", e);
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_key, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_key,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let note_type_explicit = args
            .note_type
            .as_ref()
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        let (deck_name, mut note_type) =
            resolve_deck_and_note_type(ctx, args.deck_name, args.note_type);

        // Cloze enforcement.
        let cloze_count = cards
            .iter()
            .filter(|card| card_has_cloze_markup(card))
            .count();
        let all_cloze = cloze_count == cards.len();
        if all_cloze {
            let model_names = crate::anki_connect_service::get_model_names()
                .await
                .map_err(|e| e.to_string())?;
            if !model_names.iter().any(|name| name == "Cloze") {
                let error_key = "blocks.ankiCards.errors.missingClozeNoteType".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_key, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_key,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
            if note_type != "Cloze" {
                note_type = "Cloze".to_string();
            }
        }

        // Ensure deck exists (best-effort).
        let _ = crate::anki_connect_service::create_deck_if_not_exists(&deck_name).await;

        let explicit_template_id = args
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        let requested_template_ids =
            collect_requested_template_ids(explicit_template_id.clone(), args.template_ids.clone());
        let inferred_single_template_id = infer_single_template_id_from_cards(&cards);
        let fallback_template_id = explicit_template_id.or(inferred_single_template_id);
        let mut card_note_types: HashMap<String, String> = HashMap::new();

        if !note_type_explicit && !all_cloze {
            let mut template_note_type_cache: HashMap<String, Option<String>> = HashMap::new();
            for card in &cards {
                let card_template_id = card
                    .template_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string())
                    .or_else(|| fallback_template_id.clone())
                    .or_else(|| requested_template_ids.first().cloned());
                if let Some(template_id) = card_template_id {
                    let maybe_note_type =
                        if let Some(cached) = template_note_type_cache.get(&template_id) {
                            cached.clone()
                        } else {
                            let loaded = db
                                .get_custom_template_by_id(&template_id)
                                .ok()
                                .flatten()
                                .and_then(|template| {
                                    let note = template.note_type.trim().to_string();
                                    if note.is_empty() {
                                        None
                                    } else {
                                        Some(note)
                                    }
                                });
                            template_note_type_cache.insert(template_id.clone(), loaded.clone());
                            loaded
                        };
                    if let Some(model_name) = maybe_note_type {
                        card_note_types.insert(card.id.clone(), model_name);
                    }
                }
            }
        }

        let note_ids = match crate::anki_connect_service::add_notes_to_anki_with_card_models(
            cards.clone(),
            deck_name.clone(),
            note_type.clone(),
            card_note_types,
        )
        .await
        {
            Ok(ids) => ids,
            Err(e) => {
                let error_msg = e;
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let added = note_ids.iter().filter(|id| id.is_some()).count();
        let failed = note_ids.len().saturating_sub(added);
        let status = if added == 0 {
            "error"
        } else if failed > 0 {
            "partial"
        } else {
            "ok"
        };
        let error = if added == 0 {
            Some("blocks.ankiCards.errors.ankiSyncEmpty".to_string())
        } else {
            None
        };
        let warning = if added > 0 && failed > 0 {
            Some(json!({
                "code": "anki_sync_partial",
                "details": {
                    "total": note_ids.len(),
                    "added": added,
                    "failed": failed,
                },
            }))
        } else {
            None
        };

        let output = json!({
            "status": status,
            "documentId": args.document_id,
            "deckName": deck_name,
            "noteType": note_type,
            "total": note_ids.len(),
            "added": added,
            "failed": failed,
            "error": error,
            "warning": warning,
        });

        if status == "error" {
            if let Some(msg) = output.get("error").and_then(|v| v.as_str()) {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, msg, None);
            }
            let duration_ms = start_time.elapsed().as_millis() as u64;
            let result = ToolResultInfo {
                tool_call_id: Some(call.id.clone()),
                block_id: Some(ctx.block_id.clone()),
                tool_name: call.name.clone(),
                input: call.arguments.clone(),
                output,
                success: false,
                error: error.clone(),
                duration_ms: Some(duration_ms),
                reasoning_content: None,
            };
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_control(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiControlArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_control arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let document_id = args.document_id.trim().to_string();
        if document_id.is_empty() {
            let error_msg = "documentId is required".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let db = match &ctx.anki_db {
            Some(db) => db.clone(),
            None => {
                let error_msg = "Anki database not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let llm_manager = match &ctx.llm_manager {
            Some(m) => m.clone(),
            None => {
                let error_msg = "LLM manager not available".to_string();
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let action = args.action.trim().to_lowercase();
        let enhanced = EnhancedAnkiService::new(db.clone(), llm_manager.clone());

        match action.as_str() {
            "pause" => {
                if let Err(e) = enhanced
                    .pause_document_processing(document_id.clone(), ctx.window.clone())
                    .await
                {
                    let error_msg = format!("Pause failed: {}", e);
                    ctx.emitter
                        .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }
            "resume" => {
                if let Err(e) = enhanced
                    .resume_document_processing(document_id.clone(), ctx.window.clone())
                    .await
                {
                    let error_msg = format!("Resume failed: {}", e);
                    ctx.emitter
                        .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            }
            "retry" => {
                // Retry a specific task if provided; otherwise build a unified retry task based on error cards.
                if let Some(task_id) = args
                    .task_id
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                {
                    let proc = crate::document_processing_service::DocumentProcessingService::new(
                        db.clone(),
                    );
                    let _ =
                        proc.update_task_status(task_id, crate::models::TaskStatus::Pending, None);
                } else {
                    let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                        db.clone(),
                        llm_manager.clone(),
                    );
                    let _ = streaming.build_retry_task_for_document(&document_id).await;
                }
                let _ = enhanced
                    .resume_document_processing(document_id.clone(), ctx.window.clone())
                    .await;
            }
            "cancel" => {
                let proc =
                    crate::document_processing_service::DocumentProcessingService::new(db.clone());
                let tasks = proc
                    .get_document_tasks(&document_id)
                    .map_err(|e| e.to_string())?;

                // Best-effort cancel streaming tasks.
                let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                    db.clone(),
                    llm_manager.clone(),
                );
                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                    ) {
                        let _ = streaming.cancel_streaming(t.id.clone()).await;
                    }
                }

                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Pending
                            | crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                            | crate::models::TaskStatus::Paused
                    ) {
                        let _ = proc.update_task_status(
                            &t.id,
                            crate::models::TaskStatus::Cancelled,
                            None,
                        );
                    }
                }
            }
            _ => {
                let error_msg = format!("Unsupported action: {}", args.action);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        }

        let tasks = db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let counts = compute_task_counts(&tasks);

        let output = json!({
            "status": "ok",
            "action": action,
            "documentId": document_id,
            "counts": counts,
        });

        let duration_ms = start_time.elapsed().as_millis() as u64;
        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);
        Ok(result)
    }

    async fn execute_start(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiStartArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_start arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        self.start_background_pipeline(
            call,
            ctx,
            start_time,
            PipelineInput::Content(args.content),
            args.goal,
            args.deck_name,
            args.note_type,
            args.template_mode,
            args.template_id,
            args.template_ids,
            args.debug.unwrap_or(false),
            None,
            None,
            args.max_cards,
        )
        .await
    }

    async fn execute_run(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
    ) -> Result<ToolResultInfo, String> {
        let args = match serde_json::from_value::<ChatAnkiRunArgs>(call.arguments.clone()) {
            Ok(v) => v,
            Err(e) => {
                let error_msg = format!("Invalid chatanki_run arguments: {}", e);
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let forced_route = args.route.as_deref().and_then(ChatAnkiRoute::from_str);
        let preferred_resource_ids = {
            let mut ids: Vec<String> = Vec::new();
            if let Some(id) = args.resource_id.clone().filter(|s| !s.trim().is_empty()) {
                ids.push(id);
            }
            if let Some(list) = args.resource_ids.clone() {
                for id in list {
                    if id.trim().is_empty() || ids.iter().any(|existing| existing == &id) {
                        continue;
                    }
                    ids.push(id);
                }
            }
            if ids.is_empty() {
                None
            } else {
                Some(ids)
            }
        };

        let extra_content = args.content.clone().filter(|s| !s.trim().is_empty());
        // Allow content + VFS refs to be merged when both are present.
        let input = PipelineInput::VfsRef { extra_content };

        self.start_background_pipeline(
            call,
            ctx,
            start_time,
            input,
            args.goal,
            args.deck_name,
            args.note_type,
            args.template_mode,
            args.template_id,
            args.template_ids,
            args.debug.unwrap_or(false),
            forced_route,
            preferred_resource_ids,
            args.max_cards,
        )
        .await
    }

    async fn start_background_pipeline(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
        start_time: Instant,
        input: PipelineInput,
        goal: String,
        deck_name: Option<String>,
        note_type: Option<String>,
        template_mode: ChatAnkiTemplateMode,
        template_id: Option<String>,
        template_ids: Option<Vec<String>>,
        debug_enabled: bool,
        forced_route: Option<ChatAnkiRoute>,
        preferred_resource_ids: Option<Vec<String>>,
        max_cards: Option<i32>,
    ) -> Result<ToolResultInfo, String> {
        // Minimal validation (fail fast).
        if goal.trim().is_empty() {
            let error_msg = "goal is required".to_string();
            ctx.emitter
                .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
            let result = ToolResultInfo::failure(
                Some(call.id.clone()),
                Some(ctx.block_id.clone()),
                call.name.clone(),
                call.arguments.clone(),
                error_msg,
                start_time.elapsed().as_millis() as u64,
            );
            let _ = ctx.save_tool_block(&result);
            return Ok(result);
        }

        let chat_db = ctx
            .chat_v2_db
            .as_ref()
            .ok_or("Chat V2 database not available")?
            .clone();
        let vfs_db = ctx.vfs_db.as_ref().map(|db| db.clone());
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?
            .clone();
        let anki_db = ctx
            .anki_db
            .as_ref()
            .ok_or("Anki database not available")?
            .clone();

        let anki_block_id = format!("blk_{}", uuid::Uuid::new_v4());
        // 预分配 document_id，确保 tool output 立即包含真实 ID，
        // 避免 LLM 在 chatanki_wait 超时后因无 documentId 而编造假 ID
        let pre_allocated_document_id = uuid::Uuid::new_v4().to_string();
        let now_ms = chrono::Utc::now().timestamp_millis();

        let note_type_explicit = note_type
            .as_ref()
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        let template_selection =
            match resolve_template_selection(ctx, &goal, &template_mode, template_id, template_ids)
            {
                Ok(selection) => selection,
                Err(error_msg) => {
                    ctx.emitter
                        .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
                    let result = ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        start_time.elapsed().as_millis() as u64,
                    );
                    let _ = ctx.save_tool_block(&result);
                    return Ok(result);
                }
            };
        let effective_template_mode = derive_effective_template_mode(&template_selection);
        let template_id_for_ui = template_selection.template_id.clone();
        let template_ids_for_ui = template_selection.template_ids.clone();
        let template_mode_for_ui = effective_template_mode.as_str();

        let (deck_name, mut note_type) = resolve_deck_and_note_type(ctx, deck_name, note_type);

        // If templateId is provided and user didn't explicitly set noteType, prefer template.note_type.
        if !note_type_explicit {
            if let Some(tid) = template_selection.template_id.as_deref() {
                let db = ctx.main_db.as_ref().or(ctx.anki_db.as_ref());
                if let Some(db) = db {
                    if let Ok(Some(t)) = db.get_custom_template_by_id(tid) {
                        if !t.note_type.trim().is_empty() {
                            note_type = t.note_type;
                        }
                    }
                }
            }
        }
        let options_for_ui = json!({
            "deck_name": deck_name,
            "note_type": note_type,
            "template_id": template_id_for_ui.clone(),
            "template_ids": template_ids_for_ui.clone(),
            "template_mode": template_mode_for_ui,
            "enable_images": false,
            "max_cards_per_source": 0,
        });

        let initial_tool_output = json!({
            "cards": [],
            "documentId": pre_allocated_document_id,
            "templateId": template_id_for_ui.clone(),
            "templateIds": template_ids_for_ui.clone(),
            "templateMode": template_mode_for_ui,
            "syncStatus": "pending",
            "businessSessionId": ctx.session_id,
            "messageStableId": ctx.message_id,
            "options": options_for_ui,
            "progress": {
                "stage": "queued",
                "messageKey": "blocks.ankiCards.progress.messages.queued",
                "cardsGenerated": 0,
                "counts": { "total": 0, "pending": 0, "processing": 0, "streaming": 0, "paused": 0, "completed": 0, "failed": 0, "truncated": 0, "cancelled": 0 },
                "completedRatio": 0.0
            },
            "ankiConnect": { "available": null },
            "debug": if debug_enabled { Some(json!({ "forcedRoute": forced_route.map(|r| r.as_str()), "preferredResourceIds": preferred_resource_ids })) } else { None },
        });

        // Persist anki_cards block early so user sees progress even if pipeline takes long.
        let anki_block = MessageBlock {
            id: anki_block_id.clone(),
            message_id: ctx.message_id.clone(),
            block_type: block_types::ANKI_CARDS.to_string(),
            status: block_status::RUNNING.to_string(),
            content: None,
            tool_name: Some(Self::strip_namespace(&call.name).to_string()),
            tool_input: None,
            tool_output: Some(initial_tool_output.clone()),
            citations: None,
            error: None,
            started_at: Some(now_ms),
            ended_at: None,
            first_chunk_at: Some(now_ms),
            block_index: 1,
        };
        upsert_block_allow_orphan(&chat_db, &anki_block)?;

        // Emit anki_cards start so UI creates the block and shows "running".
        ctx.emitter.emit_start(
            event_types::ANKI_CARDS,
            &ctx.message_id,
            Some(&anki_block_id),
            Some(json!({ "templateId": template_id_for_ui, "templateIds": template_ids_for_ui, "templateMode": template_mode_for_ui, "options": options_for_ui })),
            None,
        );

        // Return tool result quickly to avoid tool timeout.
        let duration_ms = start_time.elapsed().as_millis() as u64;
        let tool_output = json!({
            "status": "started",
            "ankiBlockId": anki_block_id,
            "documentId": pre_allocated_document_id,
            "message": "ChatAnki pipeline started (background)",
        });

        ctx.emitter.emit_end(
            event_types::TOOL_CALL,
            &ctx.block_id,
            Some(json!({ "result": tool_output, "durationMs": duration_ms })),
            None,
        );

        let result = ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            tool_output,
            duration_ms,
        );
        let _ = ctx.save_tool_block(&result);

        // Spawn background processing pipeline.
        let emitter = ctx.emitter.clone();
        let window = ctx.window.clone();
        let session_id = ctx.session_id.clone();
        let message_id = ctx.message_id.clone();
        let tool_name = Self::strip_namespace(&call.name).to_string();
        let tool_name_for_persist = tool_name.clone();
        let chat_db_for_persist = chat_db.clone();
        let anki_block_id_for_persist = anki_block_id.clone();
        let message_id_for_persist = message_id.clone();

        let pre_doc_id_for_spawn = pre_allocated_document_id.clone();
        tokio::spawn(async move {
            if let Err(e) = run_chatanki_pipeline_background(BackgroundParams {
                session_id,
                message_id,
                anki_block_id: anki_block_id.clone(),
                tool_name,
                chat_db,
                vfs_db,
                anki_db,
                llm_manager,
                emitter: emitter.clone(),
                window,
                input,
                goal,
                deck_name,
                note_type,
                template_id: template_selection.template_id,
                template_ids: template_selection.template_ids,
                template_mode: effective_template_mode,
                debug_enabled,
                forced_route,
                preferred_resource_ids,
                pre_allocated_document_id: pre_doc_id_for_spawn,
                max_cards,
            })
            .await
            {
                log::error!("[ChatAnkiToolExecutor] background pipeline error: {}", e);
                // Best-effort: notify UI and persist terminal error so `chatanki_wait` can stop.
                emit_anki_cards_error(&emitter, &anki_block_id_for_persist, &e);
                persist_anki_cards_terminal_block(
                    &chat_db_for_persist,
                    &message_id_for_persist,
                    &anki_block_id_for_persist,
                    &tool_name_for_persist,
                    block_status::ERROR,
                    None,
                    Some(e),
                );
            }
        });

        Ok(result)
    }
}

// ============================================================================
// Background pipeline
// ============================================================================

#[derive(Clone)]
enum PipelineInput {
    Content(String),
    VfsRef { extra_content: Option<String> },
}

struct BackgroundParams {
    session_id: String,
    message_id: String,
    anki_block_id: String,
    tool_name: String,
    chat_db: Arc<crate::chat_v2::database::ChatV2Database>,
    vfs_db: Option<Arc<VfsDatabase>>,
    anki_db: Arc<crate::database::Database>,
    llm_manager: Arc<crate::llm_manager::LLMManager>,
    emitter: Arc<crate::chat_v2::events::ChatV2EventEmitter>,
    window: tauri::Window,
    input: PipelineInput,
    goal: String,
    deck_name: String,
    note_type: String,
    template_mode: ChatAnkiTemplateMode,
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
    debug_enabled: bool,
    forced_route: Option<ChatAnkiRoute>,
    preferred_resource_ids: Option<Vec<String>>,
    /// 预分配的 document_id，确保前端 tool output 中的 ID 与后端一致
    pre_allocated_document_id: String,
    /// 用户指定的最大卡片数量（可选）
    max_cards: Option<i32>,
}

async fn run_chatanki_pipeline_background(params: BackgroundParams) -> Result<(), String> {
    // 1) Check AnkiConnect early (best-effort).
    let (anki_available, anki_error) =
        match crate::anki_connect_service::check_anki_connect_availability().await {
            Ok(v) => (Some(v), None),
            Err(e) => (Some(false), Some(e)),
        };
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({
            "ankiConnect": {
                "available": anki_available,
                "error": anki_error,
                "checkedAt": chrono::Utc::now().to_rfc3339(),
            },
            "progress": {
                "stage": "routing",
                "messageKey": "blocks.ankiCards.progress.messages.routing",
            }
        }),
    );

    // 2) Resolve content (from direct content or from VFS refs).
    let (route, mut content_text, debug_ref, mut warnings, content_error_key) = match params
        .input
        .clone()
    {
        PipelineInput::Content(content) => {
            (ChatAnkiRoute::SimpleText, content, None, Vec::new(), None)
        }
        PipelineInput::VfsRef { extra_content } => 'vfs_block: {
            let mut warnings: Vec<Value> = Vec::new();
            let mut content_error_key: Option<String> = None;

            let extra_content =
                extra_content.and_then(|c| if c.trim().is_empty() { None } else { Some(c) });

            // If the tool call didn't explicitly pass `content`, we still want to support
            // text-only workflows (user pasted material in chat). When the latest user message
            // looks like actual study material (not a short command like "继续"), prefer it.
            let fallback_text = if extra_content.is_none()
                && params
                    .preferred_resource_ids
                    .as_ref()
                    .map(|v| v.is_empty())
                    .unwrap_or(true)
                && params.forced_route.is_none()
            {
                match extract_latest_user_content(&params.chat_db, &params.session_id) {
                    Ok(Some(text)) if looks_like_material_text(&text) => Some(text),
                    _ => None,
                }
            } else {
                None
            };

            let has_fallback = fallback_text.is_some();
            let merged_extra = extra_content.or(fallback_text);
            let input_source = if has_fallback {
                Some("latest_user_message")
            } else if merged_extra.is_some() {
                Some("tool_content")
            } else {
                None
            };

            let vfs_db = match params.vfs_db.as_ref() {
                Some(db) => db,
                None => {
                    if let Some(text) = merged_extra.clone() {
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({
                                "progress": {
                                    "stage": "importing",
                                    "route": ChatAnkiRoute::SimpleText.as_str(),
                                    "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                                }
                            }),
                        );
                        let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                        break 'vfs_block (
                            ChatAnkiRoute::SimpleText,
                            text,
                            debug_ref,
                            warnings,
                            None,
                        );
                    }
                    return Err(
                        "VFS database not available (no file input + no content)".to_string()
                    );
                }
            };

            let mut context_refs = match resolve_target_context_refs(
                &params.chat_db,
                &params.session_id,
                params.preferred_resource_ids.as_deref(),
            ) {
                Ok(refs) => refs,
                Err(err_msg) => {
                    // 处理“显式传了 resourceId/resourceIds 但当前会话快照缺失”的场景：
                    // 允许从 VFS 直接解析 source_id，保证资源库搜索 -> chatanki_run 可用。
                    if let (Some(preferred_ids), Some(vfs_db)) = (
                        params.preferred_resource_ids.as_ref(),
                        params.vfs_db.as_ref(),
                    ) {
                        let mut resolved: Vec<ContextRef> = Vec::new();
                        for preferred in preferred_ids {
                            match resolve_context_ref_from_vfs_source(vfs_db, preferred) {
                                Ok(Some(context_ref)) => resolved.push(context_ref),
                                _ => return Err(err_msg.clone()),
                            }
                        }
                        if resolved.is_empty() {
                            return Err(err_msg);
                        }
                        resolved
                    } else {
                        return Err(err_msg);
                    }
                }
            };

            // 显式传了 resourceIds 时，确保每个都被解析：缺失的再走 VFS source_id 回退。
            if let Some(preferred_ids) = params.preferred_resource_ids.as_ref() {
                let mut missing: Vec<String> = preferred_ids
                    .iter()
                    .filter(|id| !context_refs.iter().any(|r| &r.resource_id == *id))
                    .cloned()
                    .collect();
                missing.dedup();

                if !missing.is_empty() {
                    let vfs_db = params.vfs_db.as_ref().ok_or_else(|| {
                        format!(
                            "Preferred resources missing and VFS unavailable: {}",
                            missing.join(",")
                        )
                    })?;

                    let mut unresolved: Vec<String> = Vec::new();
                    for id in missing {
                        match resolve_context_ref_from_vfs_source(vfs_db, &id) {
                            Ok(Some(context_ref)) => context_refs.push(context_ref),
                            _ => unresolved.push(id),
                        }
                    }
                    if !unresolved.is_empty() {
                        return Err(format!(
                            "Preferred resource not found in current session context: {}",
                            unresolved.join(",")
                        ));
                    }
                }
            }

            if context_refs.len() > 1 {
                let mut seen_ids: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                context_refs.retain(|r| seen_ids.insert(r.resource_id.clone()));
            }

            if context_refs.is_empty() {
                if let Some(text) = merged_extra.clone() {
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({
                            "progress": {
                                "stage": "importing",
                                "route": ChatAnkiRoute::SimpleText.as_str(),
                                "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                            }
                        }),
                    );
                    let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                    break 'vfs_block (ChatAnkiRoute::SimpleText, text, debug_ref, warnings, None);
                }
                content_error_key = Some("blocks.ankiCards.errors.noContent".to_string());
                let debug_ref = input_source.map(|s| json!({ "inputSource": s }));
                break 'vfs_block (
                    ChatAnkiRoute::SimpleText,
                    String::new(),
                    debug_ref,
                    warnings,
                    content_error_key,
                );
            }

            let vfs_conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
            let mut merged_ref_data = VfsContextRefData::default();
            let mut invalid_refs: Vec<String> = Vec::new();
            let mut selected_refs_debug: Vec<Value> = Vec::new();

            for context_ref in context_refs.iter() {
                selected_refs_debug.push(json!({
                    "resourceId": context_ref.resource_id,
                    "hash": context_ref.hash,
                    "typeId": context_ref.type_id,
                }));

                let vfs_resource =
                    VfsResourceRepo::get_by_hash_with_conn(&vfs_conn, &context_ref.hash)
                        .ok()
                        .flatten()
                        .or_else(|| {
                            VfsResourceRepo::get_resource_with_conn(
                                &vfs_conn,
                                &context_ref.resource_id,
                            )
                            .ok()
                            .flatten()
                        });

                let data_str = match vfs_resource.and_then(|r| r.data) {
                    Some(d) if !d.trim().is_empty() => d,
                    _ => {
                        if let Some(mut ref_data) =
                            build_single_ref_data_from_context_ref(context_ref)
                        {
                            if let Some(ref inject_modes) = context_ref.inject_modes {
                                for vfs_ref in &mut ref_data.refs {
                                    vfs_ref.inject_modes = Some(inject_modes.clone());
                                }
                            }
                            merged_ref_data.total_count += ref_data.refs.len();
                            merged_ref_data.refs.extend(ref_data.refs);
                            continue;
                        }
                        invalid_refs.push(context_ref.resource_id.clone());
                        continue;
                    }
                };

                match serde_json::from_str::<VfsContextRefData>(&data_str) {
                    Ok(mut ref_data) => {
                        if let Some(ref inject_modes) = context_ref.inject_modes {
                            for vfs_ref in &mut ref_data.refs {
                                vfs_ref.inject_modes = Some(inject_modes.clone());
                            }
                        }
                        let add_count = if ref_data.total_count > 0 {
                            ref_data.total_count
                        } else {
                            ref_data.refs.len()
                        };
                        merged_ref_data.truncated = merged_ref_data.truncated || ref_data.truncated;
                        merged_ref_data.total_count += add_count;
                        merged_ref_data.refs.extend(ref_data.refs);
                    }
                    Err(_) => {
                        if let Some(mut ref_data) =
                            build_single_ref_data_from_context_ref(context_ref)
                        {
                            if let Some(ref inject_modes) = context_ref.inject_modes {
                                for vfs_ref in &mut ref_data.refs {
                                    vfs_ref.inject_modes = Some(inject_modes.clone());
                                }
                            }
                            merged_ref_data.total_count += ref_data.refs.len();
                            merged_ref_data.refs.extend(ref_data.refs);
                            continue;
                        }
                        invalid_refs.push(context_ref.resource_id.clone());
                    }
                }
            }

            if !invalid_refs.is_empty() {
                warnings.push(json!({
                    "code": "context_ref_invalid",
                    "messageKey": "blocks.ankiCards.warnings.contextRefInvalid",
                    "messageParams": { "count": invalid_refs.len() },
                }));
            }

            let mut debug_ref = json!({});
            if let Some(source) = input_source {
                if let Some(obj) = debug_ref.as_object_mut() {
                    obj.insert("inputSource".to_string(), json!(source));
                }
            }
            if !selected_refs_debug.is_empty() {
                if let Some(obj) = debug_ref.as_object_mut() {
                    obj.insert(
                        "selectedContextRefs".to_string(),
                        json!(selected_refs_debug),
                    );
                }
            }
            let debug_ref = if debug_ref.as_object().map(|v| v.is_empty()).unwrap_or(true) {
                None
            } else {
                Some(debug_ref)
            };

            if merged_ref_data.refs.is_empty() {
                if let Some(text) = merged_extra.clone() {
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({
                            "progress": {
                                "stage": "importing",
                                "route": ChatAnkiRoute::SimpleText.as_str(),
                                "messageKey": "blocks.ankiCards.progress.messages.simpleTextDetected"
                            }
                        }),
                    );
                    break 'vfs_block (ChatAnkiRoute::SimpleText, text, debug_ref, warnings, None);
                }
                if !invalid_refs.is_empty() {
                    content_error_key =
                        Some("blocks.ankiCards.errors.contextRefInvalid".to_string());
                } else {
                    content_error_key = Some("blocks.ankiCards.errors.noContent".to_string());
                }
                break 'vfs_block (
                    ChatAnkiRoute::SimpleText,
                    String::new(),
                    debug_ref,
                    warnings,
                    content_error_key,
                );
            }

            let mut route = params
                .forced_route
                .unwrap_or_else(|| decide_route(&merged_ref_data));
            let merge_with_extra = |base: String| merge_optional_texts(base, merged_extra.clone());
            let add_truncation_warning =
                |warnings: &mut Vec<Value>, batch: &ImagePayloadBatch, limit: usize| {
                    if batch.truncated {
                        warnings.push(json!({
                            "code": "image_truncated",
                            "messageKey": "blocks.ankiCards.warnings.imageTruncated",
                            "messageParams": {
                                "shown": batch.payloads.len(),
                                "total": batch.total_images,
                                "limit": limit
                            }
                        }));
                    }
                };

            match route {
                ChatAnkiRoute::SimpleText => {
                    let extract_result =
                        extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                    if extract_result.truncated {
                        warnings.push(json!({
                            "code": "text_truncated",
                            "messageKey": "blocks.ankiCards.warnings.textTruncated",
                            "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                        }));
                    }
                    let merged_text = merge_with_extra(extract_result.text);
                    if merged_text.trim().is_empty() {
                        let image_payloads = collect_image_payloads(
                            &vfs_conn,
                            vfs_db.blobs_dir(),
                            &merged_ref_data.refs,
                            12,
                        );
                        add_truncation_warning(&mut warnings, &image_payloads, 12);
                        if !image_payloads.payloads.is_empty() {
                            route = ChatAnkiRoute::VlmFull;
                            emit_anki_cards_chunk(
                                &params.emitter,
                                &params.anki_block_id,
                                json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                            );
                            let prompt = build_import_prompt(&params.goal);
                            let output = params
                                .llm_manager
                                .call_model2_raw_prompt(&prompt, Some(image_payloads.payloads))
                                .await
                                .map_err(|e| e.to_string())?;
                            let combined = merge_with_extra(output.assistant_message);
                            break 'vfs_block (
                                route,
                                combined,
                                debug_ref,
                                warnings,
                                content_error_key,
                            );
                        }
                    }

                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                    );

                    (route, merged_text, debug_ref, warnings, content_error_key)
                }
                ChatAnkiRoute::VlmLight => {
                    let extract_result =
                        extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                    if extract_result.truncated {
                        warnings.push(json!({
                            "code": "text_truncated",
                            "messageKey": "blocks.ankiCards.warnings.textTruncated",
                            "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                        }));
                    }
                    let text = merge_with_extra(extract_result.text);
                    let image_payloads = collect_image_payloads(
                        &vfs_conn,
                        vfs_db.blobs_dir(),
                        &merged_ref_data.refs,
                        6,
                    );
                    add_truncation_warning(&mut warnings, &image_payloads, 6);
                    if image_payloads.payloads.is_empty() {
                        let fallback_route = ChatAnkiRoute::SimpleText;
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({ "progress": { "stage": "importing", "route": fallback_route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                        );
                        break 'vfs_block (
                            fallback_route,
                            text,
                            debug_ref,
                            warnings,
                            content_error_key,
                        );
                    }
                    // 🔧 修复：VLM 调用前发送专用进度消息，让用户知道正在识别图片
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                    );
                    let prompt = build_vlm_light_prompt(&params.goal);
                    let output = params
                        .llm_manager
                        .call_model2_raw_prompt(&prompt, Some(image_payloads.payloads))
                        .await
                        .map_err(|e| e.to_string())?;

                    let visual_md = output.assistant_message;
                    let combined = if text.trim().is_empty() {
                        visual_md
                    } else if visual_md.trim().is_empty() {
                        text
                    } else {
                        format!("{text}\n\n# 视觉补充\n\n{visual_md}")
                    };

                    (route, combined, debug_ref, warnings, content_error_key)
                }
                ChatAnkiRoute::VlmFull => {
                    let image_payloads = collect_image_payloads(
                        &vfs_conn,
                        vfs_db.blobs_dir(),
                        &merged_ref_data.refs,
                        12,
                    );
                    add_truncation_warning(&mut warnings, &image_payloads, 12);
                    if image_payloads.payloads.is_empty() {
                        let extract_result =
                            extract_text_from_refs(&vfs_conn, vfs_db.blobs_dir(), &merged_ref_data);
                        if extract_result.truncated {
                            warnings.push(json!({
                                "code": "text_truncated",
                                "messageKey": "blocks.ankiCards.warnings.textTruncated",
                                "messageParams": { "limitMB": MAX_REF_TEXT_BYTES / 1_000_000 }
                            }));
                        }
                        let merged_text = merge_with_extra(extract_result.text);
                        let fallback_route = ChatAnkiRoute::SimpleText;
                        emit_anki_cards_chunk(
                            &params.emitter,
                            &params.anki_block_id,
                            json!({ "progress": { "stage": "importing", "route": fallback_route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.importing" } }),
                        );
                        break 'vfs_block (
                            fallback_route,
                            merged_text,
                            debug_ref,
                            warnings,
                            content_error_key,
                        );
                    }
                    // 🔧 修复：VLM 调用前发送专用进度消息，让用户知道正在识别图片
                    emit_anki_cards_chunk(
                        &params.emitter,
                        &params.anki_block_id,
                        json!({ "progress": { "stage": "importing", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.vlmExtracting" } }),
                    );
                    let prompt = build_import_prompt(&params.goal);
                    let output = params
                        .llm_manager
                        .call_model2_raw_prompt(&prompt, Some(image_payloads.payloads))
                        .await
                        .map_err(|e| e.to_string())?;
                    let combined = merge_with_extra(output.assistant_message);
                    (route, combined, debug_ref, warnings, content_error_key)
                }
            }
        }
    };

    // Glossary-like inputs (e.g. 120 term definitions) often use single newlines instead of blank lines.
    // Our default segmenter splits paragraphs by "\n\n"; normalize to preserve entry boundaries.
    if looks_like_glossary_content(&content_text) {
        content_text = normalize_glossary_paragraphs(&content_text);
    }

    if content_text.trim().is_empty() {
        let error_key =
            content_error_key.unwrap_or_else(|| "blocks.ankiCards.errors.noContent".to_string());
        emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
        persist_anki_cards_terminal_block(
            &params.chat_db,
            &params.message_id,
            &params.anki_block_id,
            &params.tool_name,
            block_status::ERROR,
            Some(json!({
                "cards": [],
                "documentId": null,
                "syncStatus": "error",
                "progress": { "stage": "completed", "messageKey": error_key.clone() },
            })),
            Some(error_key),
        );
        return Ok(());
    }

    // 3) Start EnhancedAnkiService for streaming generation (robust, resumable).
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({ "progress": { "stage": "generating", "route": route.as_str(), "messageKey": "blocks.ankiCards.progress.messages.generating" } }),
    );

    // 模板策略：只要解析出了单模板 template_id（包括 all/multiple 下的降维选择），就按该模板驱动字段抽取。
    let single_template_id = resolve_single_template_id(params.template_id.as_deref());
    let template = if let Some(tid) = single_template_id {
        if !matches!(params.template_mode, ChatAnkiTemplateMode::Single) {
            log::info!(
                "[ChatAnkiToolExecutor] single template {} resolved under templateMode={} (forcing template-aware generation)",
                tid,
                params.template_mode.as_str()
            );
        }
        match params.anki_db.get_custom_template_by_id(tid) {
            Ok(Some(t)) => Some(t),
            Ok(None) => {
                let error_key = "blocks.ankiCards.errors.templateNotFound".to_string();
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
                persist_anki_cards_terminal_block(
                    &params.chat_db,
                    &params.message_id,
                    &params.anki_block_id,
                    &params.tool_name,
                    block_status::ERROR,
                    None,
                    Some(error_key),
                );
                return Ok(());
            }
            Err(e) => {
                let error_key = "blocks.ankiCards.errors.templateLoadFailed".to_string();
                log::error!("[ChatAnkiToolExecutor] load template failed: {}", e);
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
                persist_anki_cards_terminal_block(
                    &params.chat_db,
                    &params.message_id,
                    &params.anki_block_id,
                    &params.tool_name,
                    block_status::ERROR,
                    None,
                    Some(error_key),
                );
                return Ok(());
            }
        }
    } else {
        None
    };

    let mut options = build_generation_options(
        &params.goal,
        &params.deck_name,
        &params.note_type,
        &content_text,
        template.as_ref(),
        params.max_cards,
    );

    // 多模板模式：使用启动阶段已校验过的 template_ids，避免隐式“全模板”导致体验偏差。
    if template.is_none() {
        if let Some(template_ids) = params.template_ids.as_ref() {
            if !template_ids.is_empty() {
                let mut template_descriptions = Vec::new();
                let mut template_fields_by_id = HashMap::new();
                let mut field_extraction_rules_by_id = HashMap::new();
                let mut missing_or_failed_template_ids: Vec<String> = Vec::new();

                for tid in template_ids {
                    match params.anki_db.get_custom_template_by_id(tid) {
                        Ok(Some(t)) => {
                            template_descriptions.push(crate::models::TemplateDescription {
                                id: t.id.clone(),
                                name: t.name.clone(),
                                description: t.description.clone(),
                                fields: t.fields.clone(),
                                generation_prompt: if t.generation_prompt.trim().is_empty() {
                                    None
                                } else {
                                    Some(t.generation_prompt.clone())
                                },
                            });
                            let fields = normalize_template_fields(&t.fields);
                            let rules =
                                ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
                            template_fields_by_id.insert(t.id.clone(), fields);
                            field_extraction_rules_by_id.insert(t.id.clone(), rules);
                        }
                        Ok(None) => {
                            log::warn!(
                                "[ChatAnkiToolExecutor] template {} not found when building multi-template options",
                                tid
                            );
                            missing_or_failed_template_ids.push(tid.clone());
                        }
                        Err(e) => {
                            log::warn!(
                                "[ChatAnkiToolExecutor] load template {} failed when building multi-template options: {}",
                                tid,
                                e
                            );
                            missing_or_failed_template_ids.push(tid.clone());
                        }
                    }
                }

                if !missing_or_failed_template_ids.is_empty() {
                    warnings.push(json!({
                        "code": "template_load_partial",
                        "messageKey": "blocks.ankiCards.warnings.templateLoadPartial",
                        "messageParams": {
                            "count": missing_or_failed_template_ids.len(),
                        }
                    }));
                }

                if !template_descriptions.is_empty() {
                    options.template_ids = Some(template_ids.clone());
                    options.template_descriptions = Some(template_descriptions);
                    options.template_fields_by_id = Some(template_fields_by_id);
                    options.field_extraction_rules_by_id = Some(field_extraction_rules_by_id);
                }
            }
        }
    }
    if !warnings.is_empty() {
        let warnings_patch = json!({ "warnings": warnings.clone() });
        emit_anki_cards_chunk(
            &params.emitter,
            &params.anki_block_id,
            warnings_patch.clone(),
        );
        persist_anki_cards_running_patch(
            &params.chat_db,
            &params.message_id,
            &params.anki_block_id,
            &params.tool_name,
            warnings_patch,
        );
    }
    let enhanced = EnhancedAnkiService::new(params.anki_db.clone(), params.llm_manager.clone());
    // 使用 goal 作为文档名称，而不是硬编码 "chatanki"
    let doc_name = if params.goal.trim().is_empty() {
        "chatanki".to_string()
    } else {
        // 截取前 80 字符作为文档名
        let name = params.goal.trim();
        if name.chars().count() > 80 {
            format!("{}...", safe_truncate_chars(name, 77))
        } else {
            name.to_string()
        }
    };
    let request = AnkiDocumentGenerationRequest {
        document_content: content_text,
        original_document_name: Some(doc_name),
        options: Some(options),
    };

    // 使用预分配的 document_id，确保与 tool output 中的 ID 一致
    let document_id = match enhanced
        .start_document_processing_with_id(
            request,
            params.window.clone(),
            params.pre_allocated_document_id.clone(),
        )
        .await
    {
        Ok(v) => {
            // 🔧 Phase 1: 记录 source_session_id，用于任务管理页面跳转回聊天上下文
            if let Err(e) = params
                .anki_db
                .set_document_session_source(&v, &params.session_id)
            {
                log::warn!(
                    "[ChatAnkiToolExecutor] Failed to set source_session_id: {}",
                    e
                );
            }
            v
        }
        Err(e) => {
            let error_key = "blocks.ankiCards.errors.startFailed".to_string();
            log::error!(
                "[ChatAnkiToolExecutor] start document processing failed: {}",
                e
            );
            emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            persist_anki_cards_terminal_block(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                block_status::ERROR,
                None,
                Some(error_key),
            );
            return Ok(());
        }
    };

    // 4) Poll tasks/cards and stream updates to anki_cards block.
    let mut seen_cards: HashSet<String> = HashSet::new();
    let mut last_counts: Option<Value> = None;
    let mut last_ratio: Option<f32> = None;

    // Put documentId into block state early.
    emit_anki_cards_chunk(
        &params.emitter,
        &params.anki_block_id,
        json!({
            "documentId": document_id,
            "progress": { "messageKey": "blocks.ankiCards.progress.messages.taskCreated" },
            "debug": if params.debug_enabled { debug_ref.clone() } else { None },
        }),
    );
    // Persist a minimal running snapshot so `chatanki_wait` can discover documentId via DB.
    persist_anki_cards_running_patch(
        &params.chat_db,
        &params.message_id,
        &params.anki_block_id,
        &params.tool_name,
        json!({
            "documentId": document_id,
            "progress": { "messageKey": "blocks.ankiCards.progress.messages.taskCreated" },
            "debug": if params.debug_enabled { debug_ref.clone() } else { None },
        }),
    );

    // Poll loop (best-effort, stop when completed or paused).
    const POLL_INTERVAL: Duration = Duration::from_millis(900);
    const MAX_CARDS_PER_CHUNK: usize = 25;
    let started_at = std::time::Instant::now();
    const MAX_TOTAL_DURATION: Duration = Duration::from_secs(60 * 30); // 30 minutes
    let global_card_limit = params
        .max_cards
        .and_then(|v| if v > 0 { Some(v as usize) } else { None });
    let mut limit_cancel_triggered = false;

    loop {
        if started_at.elapsed() > MAX_TOTAL_DURATION {
            let error_key = "blocks.ankiCards.errors.pipelineTimeout".to_string();
            // Best-effort: cancel running tasks so UI aligns with timeout state.
            let proc = crate::document_processing_service::DocumentProcessingService::new(
                params.anki_db.clone(),
            );
            match proc.get_document_tasks(&document_id) {
                Ok(tasks) => {
                    let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                        params.anki_db.clone(),
                        params.llm_manager.clone(),
                    );
                    for t in tasks.iter() {
                        if matches!(
                            t.status,
                            crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                        ) {
                            let _ = streaming.cancel_streaming(t.id.clone()).await;
                        }
                    }
                    for t in tasks.iter() {
                        if matches!(
                            t.status,
                            crate::models::TaskStatus::Pending
                                | crate::models::TaskStatus::Processing
                                | crate::models::TaskStatus::Streaming
                                | crate::models::TaskStatus::Paused
                        ) {
                            let _ = proc.update_task_status(
                                &t.id,
                                crate::models::TaskStatus::Cancelled,
                                None,
                            );
                        }
                    }
                }
                Err(e) => {
                    log::warn!(
                        "[ChatAnkiToolExecutor] timeout cancel failed for {}: {}",
                        document_id,
                        e
                    );
                }
            }
            emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            persist_anki_cards_terminal_block(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                block_status::ERROR,
                None,
                Some(error_key),
            );
            break;
        }

        let tasks = params
            .anki_db
            .get_tasks_for_document(&document_id)
            .map_err(|e| e.to_string())?;
        let cards = params
            .anki_db
            .get_cards_for_document(&document_id)
            .map_err(|e| e.to_string())?;

        let counts = compute_task_counts(&tasks);
        let ratio = counts
            .get("completedRatio")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0) as f32;
        let is_paused = tasks
            .iter()
            .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
        let is_in_progress = tasks.iter().any(|t| {
            matches!(
                t.status,
                crate::models::TaskStatus::Pending
                    | crate::models::TaskStatus::Processing
                    | crate::models::TaskStatus::Streaming
            )
        });
        let has_cancelled = tasks
            .iter()
            .any(|t| matches!(t.status, crate::models::TaskStatus::Cancelled));

        if let Some(limit) = global_card_limit {
            if cards.len() >= limit && is_in_progress && !limit_cancel_triggered {
                limit_cancel_triggered = true;
                let proc = crate::document_processing_service::DocumentProcessingService::new(
                    params.anki_db.clone(),
                );
                let streaming = crate::streaming_anki_service::StreamingAnkiService::new(
                    params.anki_db.clone(),
                    params.llm_manager.clone(),
                );
                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                    ) {
                        let _ = streaming.cancel_streaming(t.id.clone()).await;
                    }
                }
                for t in tasks.iter() {
                    if matches!(
                        t.status,
                        crate::models::TaskStatus::Pending
                            | crate::models::TaskStatus::Processing
                            | crate::models::TaskStatus::Streaming
                            | crate::models::TaskStatus::Paused
                    ) {
                        let _ = proc.update_task_status(
                            &t.id,
                            crate::models::TaskStatus::Cancelled,
                            Some("GLOBAL_CARD_LIMIT_REACHED".to_string()),
                        );
                    }
                }
            }
        }

        let stage = if is_in_progress {
            "generating"
        } else if is_paused {
            "paused"
        } else if has_cancelled {
            "cancelled"
        } else {
            "completed"
        };
        let stage_message_key: Option<&str> = match stage {
            "paused" => Some("blocks.ankiCards.progress.messages.paused"),
            "cancelled" => Some("blocks.ankiCards.progress.messages.cancelled"),
            _ => None,
        };

        // Stream new cards (in small batches).
        let visible_card_count = global_card_limit
            .map(|limit| std::cmp::min(cards.len(), limit))
            .unwrap_or(cards.len());
        let mut new_cards: Vec<Value> = Vec::new();
        for c in cards.iter().take(visible_card_count) {
            if seen_cards.insert(c.id.clone()) {
                new_cards.push(convert_backend_card(c));
            }
        }

        // Avoid emitting too frequently when nothing changes.
        let counts_changed = last_counts.as_ref().map(|v| v != &counts).unwrap_or(true);
        let ratio_changed = last_ratio
            .map(|v| (v - ratio).abs() > 0.001)
            .unwrap_or(true);

        if counts_changed || ratio_changed || !new_cards.is_empty() {
            let progress_patch = json!({
                "documentId": document_id,
                "progress": {
                    "stage": stage,
                    "route": route.as_str(),
                    "messageKey": stage_message_key,
                    "cardsGenerated": visible_card_count,
                    "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                    "completedRatio": ratio,
                    "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                }
            });

            let mut cursor = 0usize;
            while cursor < new_cards.len() {
                let end = std::cmp::min(cursor + MAX_CARDS_PER_CHUNK, new_cards.len());
                emit_anki_cards_chunk(
                    &params.emitter,
                    &params.anki_block_id,
                    json!({
                        "documentId": document_id,
                        "cards": &new_cards[cursor..end],
                        "progress": {
                            "stage": stage,
                            "route": route.as_str(),
                            "messageKey": stage_message_key,
                            "cardsGenerated": visible_card_count,
                            "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                            "completedRatio": ratio,
                            "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                        }
                    }),
                );
                cursor = end;
            }

            if new_cards.is_empty() {
                // No cards in this tick, still update progress.
                emit_anki_cards_chunk(
                    &params.emitter,
                    &params.anki_block_id,
                    progress_patch.clone(),
                );
            }

            // Persist progress snapshot without cards to avoid array merge issues.
            persist_anki_cards_running_patch(
                &params.chat_db,
                &params.message_id,
                &params.anki_block_id,
                &params.tool_name,
                progress_patch,
            );

            last_counts = Some(counts.clone());
            last_ratio = Some(ratio);
        }

        if !is_in_progress && !is_paused {
            // Done: emit end with full cards list.
            if cards.len() > visible_card_count {
                for c in cards.iter().skip(visible_card_count) {
                    let _ = params.anki_db.delete_anki_card(&c.id);
                }
            }
            let final_cards: Vec<Value> = cards
                .iter()
                .take(visible_card_count)
                .map(convert_backend_card)
                .collect();
            let has_failed = tasks.iter().any(|t| {
                matches!(
                    t.status,
                    crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
                )
            });
            let failed_count = tasks
                .iter()
                .filter(|t| matches!(t.status, crate::models::TaskStatus::Failed))
                .count();
            let truncated_count = tasks
                .iter()
                .filter(|t| matches!(t.status, crate::models::TaskStatus::Truncated))
                .count();
            let final_stage = if has_cancelled {
                "cancelled"
            } else {
                "completed"
            };
            let template_id = params.template_id.clone();
            let template_id_for_options = template_id.clone();
            let template_ids = params.template_ids.clone();
            let template_mode = params.template_mode.as_str();
            let final_message_key = if has_cancelled {
                Some("blocks.ankiCards.progress.messages.cancelled")
            } else if has_failed {
                Some("blocks.ankiCards.progress.messages.completedWithErrors")
            } else {
                None
            };
            let final_message_params = if has_failed {
                Some(json!({ "failed": failed_count, "truncated": truncated_count }))
            } else {
                None
            };
            let final_error_key = if !has_cancelled && has_failed {
                Some("blocks.ankiCards.errors.partialSegmentsFailed".to_string())
            } else {
                None
            };
            let final_output = json!({
                "cards": final_cards,
                "documentId": document_id,
                "templateId": template_id,
                "templateIds": template_ids.clone(),
                "templateMode": template_mode,
                "syncStatus": "pending",
                "businessSessionId": params.session_id,
                "messageStableId": params.message_id,
                "options": {
                    "deck_name": params.deck_name,
                    "note_type": params.note_type,
                    "template_id": template_id_for_options,
                    "template_ids": template_ids,
                    "template_mode": template_mode,
                    "enable_images": false,
                    "max_cards_per_source": 0
                },
                "warnings": warnings,
                "progress": {
                    "stage": final_stage,
                    "route": route.as_str(),
                    "messageKey": final_message_key,
                    "messageParams": final_message_params.clone(),
                    "cardsGenerated": visible_card_count,
                    "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                    "completedRatio": ratio,
                    "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                },
                "ankiConnect": {
                    "available": anki_available,
                    "error": anki_error,
                    "checkedAt": chrono::Utc::now().to_rfc3339(),
                },
                "debug": if params.debug_enabled { debug_ref } else { None },
            });

            // Persist final block (best-effort).
            let now_ms = chrono::Utc::now().timestamp_millis();
            let block = MessageBlock {
                id: params.anki_block_id.clone(),
                message_id: params.message_id.clone(),
                block_type: block_types::ANKI_CARDS.to_string(),
                status: if !has_cancelled && has_failed {
                    block_status::ERROR.to_string()
                } else {
                    block_status::SUCCESS.to_string()
                },
                content: None,
                tool_name: Some(params.tool_name.clone()),
                tool_input: None,
                tool_output: Some(final_output.clone()),
                citations: None,
                error: final_error_key.clone(),
                started_at: Some(now_ms),
                ended_at: Some(now_ms),
                first_chunk_at: Some(now_ms),
                block_index: 1,
            };
            let _ = upsert_block_allow_orphan(&params.chat_db, &block);

            if !has_cancelled && has_failed {
                // Ensure UI receives a final progress snapshot before switching to error status.
                emit_anki_cards_chunk(
                    &params.emitter,
                    &params.anki_block_id,
                    json!({
                        "documentId": document_id,
                        "progress": {
                            "stage": final_stage,
                            "route": route.as_str(),
                            "messageKey": final_message_key,
                            "messageParams": final_message_params.clone(),
                            "cardsGenerated": cards.len(),
                            "counts": counts.get("counts").cloned().unwrap_or(json!({})),
                            "completedRatio": ratio,
                            "lastUpdatedAt": chrono::Utc::now().to_rfc3339(),
                        }
                    }),
                );

                // Notify UI as error (cards are preserved); do not emit_end to avoid flipping to success.
                let error_key = final_error_key
                    .unwrap_or_else(|| "blocks.ankiCards.errors.partialSegmentsFailed".to_string());
                emit_anki_cards_error(&params.emitter, &params.anki_block_id, &error_key);
            } else {
                params.emitter.emit_end(
                    event_types::ANKI_CARDS,
                    &params.anki_block_id,
                    Some(final_output),
                    None,
                );
            }
            break;
        }

        sleep(POLL_INTERVAL).await;
    }

    Ok(())
}

fn resolve_single_template_id(template_id: Option<&str>) -> Option<&str> {
    template_id.map(str::trim).filter(|s| !s.is_empty())
}

fn collect_requested_template_ids(
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();

    if let Some(single) = template_id
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
    {
        ids.push(single);
    }

    for raw in template_ids.unwrap_or_default() {
        for item in raw.split(',') {
            let trimmed = item.trim();
            if !trimmed.is_empty() {
                ids.push(trimmed.to_string());
            }
        }
    }

    ids.sort();
    ids.dedup();
    ids
}

fn infer_single_template_id_from_cards(cards: &[crate::models::AnkiCard]) -> Option<String> {
    let unique_ids: HashSet<String> = cards
        .iter()
        .filter_map(|card| {
            card.template_id
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        })
        .collect();
    if unique_ids.len() == 1 {
        unique_ids.into_iter().next()
    } else {
        None
    }
}

fn derive_effective_template_mode(selection: &TemplateSelection) -> ChatAnkiTemplateMode {
    if selection
        .template_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .is_some()
    {
        ChatAnkiTemplateMode::Single
    } else {
        let count = selection
            .template_ids
            .as_ref()
            .map(|ids| ids.iter().filter(|id| !id.trim().is_empty()).count())
            .unwrap_or(0);
        if count > 1 {
            ChatAnkiTemplateMode::Multiple
        } else {
            ChatAnkiTemplateMode::Single
        }
    }
}

fn looks_like_material_text(text: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }

    // Heuristic: avoid treating short user commands ("继续/开始/好了吗") as material.
    let len = t.chars().count();
    if len >= 120 {
        return true;
    }
    t.contains('\n') && len >= 60
}

fn contains_cloze_markup(text: &str) -> bool {
    let t = text.trim();
    t.contains("{{c") && t.contains("}}")
}

fn card_has_cloze_markup(card: &crate::models::AnkiCard) -> bool {
    if let Some(text) = card.text.as_deref() {
        if contains_cloze_markup(text) {
            return true;
        }
    }
    if contains_cloze_markup(&card.front) || contains_cloze_markup(&card.back) {
        return true;
    }
    card.extra_fields.values().any(|v| contains_cloze_markup(v))
}

fn extract_latest_user_content(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
) -> Result<Option<String>, String> {
    let conn = chat_db.get_conn_safe().map_err(|e| e.to_string())?;
    let messages =
        ChatV2Repo::get_session_messages_with_conn(&conn, session_id).map_err(|e| e.to_string())?;

    // Prefer the most recent *material-like* user message, not necessarily the last user message.
    // This avoids picking short commands like "继续/1/好了吗" as input.
    for m in messages
        .iter()
        .rev()
        .filter(|m| m.role == MessageRole::User)
    {
        let blocks =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &m.id).map_err(|e| e.to_string())?;
        let mut parts: Vec<String> = Vec::new();
        for b in blocks {
            if b.block_type == block_types::CONTENT {
                if let Some(content) = b.content {
                    let t = content.trim();
                    if !t.is_empty() {
                        parts.push(t.to_string());
                    }
                }
            }
        }

        let joined = parts.join("\n\n").trim().to_string();
        if joined.is_empty() {
            continue;
        }
        if looks_like_material_text(&joined) {
            return Ok(Some(joined));
        }
    }

    Ok(None)
}

fn decide_route(ref_data: &VfsContextRefData) -> ChatAnkiRoute {
    // Heuristic MVP:
    // - No images: simple_text
    // - Few images + has file text: vlm_light (text-first + visual补充)
    // - Many images / image-only: vlm_full
    let mut image_count = 0usize;
    let mut file_count = 0usize;
    for r in ref_data.refs.iter() {
        match r.resource_type {
            VfsResourceType::Image => image_count += 1,
            VfsResourceType::File => file_count += 1,
            _ => {}
        }
    }

    if image_count == 0 {
        // PDF-heavy docs often benefit from VLM when extracted_text is poor, but we can't cheaply
        // evaluate OCR quality here. Default to simple_text and let users override.
        return ChatAnkiRoute::SimpleText;
    }

    if file_count > 0 && image_count <= 3 {
        return ChatAnkiRoute::VlmLight;
    }

    ChatAnkiRoute::VlmFull
}

fn build_import_prompt(goal: &str) -> String {
    // MVP: keep prompt short but enforce chunk markers for downstream robustness.
    format!(
        "你是 ChatAnki 的「高级视觉感知与语义建模引擎」。\n\
你的任务：将用户提供的文档图片（可能是PDF页面/截图）转化为结构化 Markdown。\n\
\n\
学习目标：{goal}\n\
\n\
输出要求：\n\
1) 使用 Markdown 标题层级组织内容。\n\
2) 将内容分成多个 Chunk，每个 Chunk 用以下结构：\n\
   [CHUNK_ID]: file-001-chunk-0001\n\
   正文...\n\
   [SUMMARY]: 50字以内摘要\n\
   [CHUNK_END]\n\
3) 不要输出任何多余解释，只输出 Markdown。\n\
4) 遇到图表/流程图必须用 [IMAGE_DESC: ...] 条目式还原关键逻辑。\n"
    )
}

fn build_vlm_light_prompt(goal: &str) -> String {
    format!(
        "你是 ChatAnki 的「视觉补充提取器」。\n\
学习目标：{goal}\n\
\n\
输入是一组图片（图表/截图/公式页）。\n\
请只输出图片相关的结构化 Markdown，不要复述非图片文本。\n\
\n\
输出要求：\n\
- 若有多张图片，请按顺序输出多个小节，每节用 `## 图 N` 标题。\n\
- 每个小节必须包含一行 `[IMAGE_DESC: ...]`（条目式，强调流程/因果/结构）。\n\
- 遇到表格/公式尽量保留结构（表格/LaTeX）。\n\
- 不要输出任何额外解释。\n"
    )
}

// 🔧 文本提取上限：与下游 EnhancedAnkiService.MAX_DOCUMENT_SIZE 对齐为 10MB。
// 确保上游提取不会成为瓶颈：VFS 完整存储文件内容 → 提取文本上限 10MB →
// 下游分段系统按 10k tokens/段切分 → 并发生成。
//
// 实际容量：10MB 纯文本 ≈ 300 万汉字 / ~1000 页，覆盖绝大多数教材/论文。
// 超大文档（>10MB 文本）建议用户拆分后分批制卡。
const MAX_REF_TEXT_BYTES: usize = 10_000_000;

fn push_with_budget(out: &mut String, text: &str, remaining: &mut usize) -> bool {
    if *remaining == 0 {
        return false;
    }
    if text.len() <= *remaining {
        out.push_str(text);
        *remaining -= text.len();
        return true;
    }
    let mut cut = *remaining;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    if cut > 0 {
        out.push_str(&text[..cut]);
    }
    *remaining = 0;
    false
}

fn merge_optional_texts(base: String, extra: Option<String>) -> String {
    let base_trimmed = base.trim();
    let extra_trimmed = extra.as_deref().unwrap_or("").trim();
    if base_trimmed.is_empty() && extra_trimmed.is_empty() {
        String::new()
    } else if base_trimmed.is_empty() {
        extra_trimmed.to_string()
    } else if extra_trimmed.is_empty() {
        base_trimmed.to_string()
    } else {
        format!("{base_trimmed}\n\n{extra_trimmed}")
    }
}

struct ImagePayloadBatch {
    payloads: Vec<ImagePayload>,
    total_images: usize,
    truncated: bool,
}

fn collect_image_payloads(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    refs: &[VfsResourceRef],
    max_images: usize,
) -> ImagePayloadBatch {
    use crate::chat_v2::vfs_resolver::resolve_vfs_ref_to_blocks;
    use crate::chat_v2::vfs_resolver::ContentBlock;

    let mut out: Vec<ImagePayload> = Vec::new();
    let mut total_images = 0usize;
    let mut truncated = false;

    for r in refs {
        // Only VLM routes need images. Let resolver decide how to fetch PDF page previews, etc.
        let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, r, true);
        for b in blocks {
            if let ContentBlock::Image { media_type, base64 } = b {
                total_images += 1;
                if out.len() < max_images {
                    out.push(ImagePayload {
                        mime: media_type,
                        base64,
                    });
                } else {
                    truncated = true;
                }
            }
        }
    }

    if total_images > max_images {
        truncated = true;
    }

    ImagePayloadBatch {
        payloads: out,
        total_images,
        truncated,
    }
}

/// 提取结果：文本 + 是否被截断
struct ExtractTextResult {
    text: String,
    truncated: bool,
}

fn extract_text_from_refs(
    conn: &Connection,
    blobs_dir: &std::path::Path,
    ref_data: &VfsContextRefData,
) -> ExtractTextResult {
    use crate::chat_v2::vfs_resolver::resolve_vfs_ref_to_blocks;
    use crate::chat_v2::vfs_resolver::ContentBlock;

    let mut out = String::new();
    let mut remaining = MAX_REF_TEXT_BYTES;
    let mut truncated = false;

    for r in &ref_data.refs {
        if remaining == 0 {
            truncated = true;
            break;
        }
        match r.resource_type {
            VfsResourceType::File => {
                // Prefer stored extracted_text (unescaped), fallback to parsing blob.
                let extracted: Option<String> = conn
                    .query_row(
                        "SELECT extracted_text FROM files WHERE id = ?1",
                        rusqlite::params![r.source_id],
                        |row| row.get(0),
                    )
                    .ok()
                    .flatten()
                    .filter(|t: &String| !t.trim().is_empty());

                let text = if let Some(t) = extracted {
                    t
                } else {
                    // Fallback: parse blob content from base64
                    match VfsFileRepo::get_content_with_conn(conn, blobs_dir, &r.source_id) {
                        Ok(Some(base64_content)) => {
                            let parser = crate::document_parser::DocumentParser::new();
                            parser
                                .extract_text_from_base64(&r.name, &base64_content)
                                .unwrap_or_else(|_| "".to_string())
                        }
                        _ => "".to_string(),
                    }
                };

                if !text.trim().is_empty() {
                    let header = format!("\n\n# {}\n\n", r.name);
                    if !push_with_budget(&mut out, &header, &mut remaining) {
                        truncated = true;
                        break;
                    }
                    if !push_with_budget(&mut out, &text, &mut remaining) {
                        truncated = true;
                        break;
                    }
                }
            }
            // For non-file refs, fall back to resolver text blocks.
            _ => {
                let blocks = resolve_vfs_ref_to_blocks(conn, blobs_dir, r, false);
                for b in blocks {
                    if let ContentBlock::Text { text } = b {
                        if !text.trim().is_empty() {
                            if !push_with_budget(&mut out, "\n\n", &mut remaining) {
                                truncated = true;
                                break;
                            }
                            if !push_with_budget(&mut out, &text, &mut remaining) {
                                truncated = true;
                                break;
                            }
                        }
                    }
                }
            }
        }
        if truncated {
            break;
        }
    }

    if truncated {
        log::warn!(
            "[ChatAnki] Truncated context refs text at {} bytes",
            MAX_REF_TEXT_BYTES
        );
    }
    ExtractTextResult {
        text: out.trim().to_string(),
        truncated,
    }
}

fn resolve_target_context_refs(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    session_id: &str,
    preferred_resource_ids: Option<&[String]>,
) -> Result<Vec<ContextRef>, String> {
    let conn = chat_db.get_conn_safe().map_err(|e| e.to_string())?;
    let messages =
        ChatV2Repo::get_session_messages_with_conn(&conn, session_id).map_err(|e| e.to_string())?;

    if let Some(preferred_ids_raw) = preferred_resource_ids {
        // 支持多资源：跨多条消息快照聚合，按调用参数顺序返回。
        let mut preferred_ids: Vec<String> = Vec::new();
        for id in preferred_ids_raw {
            if id.trim().is_empty() || preferred_ids.iter().any(|x| x == id) {
                continue;
            }
            preferred_ids.push(id.clone());
        }
        if preferred_ids.is_empty() {
            return Ok(Vec::new());
        }

        let mut found: std::collections::HashMap<String, ContextRef> =
            std::collections::HashMap::new();
        for msg in messages.iter().rev() {
            let Some(meta) = &msg.meta else { continue };
            let Some(snapshot) = &meta.context_snapshot else {
                continue;
            };

            for r in snapshot.user_refs.iter().filter(|r| {
                matches!(r.type_id.as_str(), "file" | "image" | "folder")
                    && preferred_ids.iter().any(|id| id == &r.resource_id)
            }) {
                found
                    .entry(r.resource_id.clone())
                    .or_insert_with(|| r.clone());
            }

            if found.len() >= preferred_ids.len() {
                break;
            }
        }

        if found.is_empty() {
            return Err(format!(
                "Preferred resource not found in current session context: {}",
                preferred_ids.join(",")
            ));
        }

        let refs: Vec<ContextRef> = preferred_ids
            .iter()
            .filter_map(|id| found.get(id).cloned())
            .collect();
        return Ok(refs);
    }

    // 没有显式指定资源时：沿用旧策略，取最新一条包含可用用户引用的快照。
    for msg in messages.iter().rev() {
        let Some(meta) = &msg.meta else { continue };
        let Some(snapshot) = &meta.context_snapshot else {
            continue;
        };

        let refs: Vec<ContextRef> = snapshot
            .user_refs
            .iter()
            .filter(|r| matches!(r.type_id.as_str(), "file" | "image" | "folder"))
            .cloned()
            .collect();
        if !refs.is_empty() {
            return Ok(refs);
        }
    }

    Ok(Vec::new())
}

fn build_single_ref_data_from_context_ref(context_ref: &ContextRef) -> Option<VfsContextRefData> {
    if context_ref.hash.trim().is_empty() {
        return None;
    }

    let source_id = context_ref.resource_id.clone();
    let resource_type = if context_ref.type_id == "image" {
        VfsResourceType::Image
    } else if source_id.starts_with("tb_") {
        VfsResourceType::Textbook
    } else if source_id.starts_with("file_") || source_id.starts_with("att_") {
        VfsResourceType::File
    } else if source_id.starts_with("fld_") {
        return None;
    } else {
        return None;
    };

    let name = context_ref
        .display_name
        .clone()
        .unwrap_or_else(|| source_id.clone());

    Some(VfsContextRefData {
        refs: vec![VfsResourceRef {
            source_id,
            resource_hash: context_ref.hash.clone(),
            resource_type,
            name,
            inject_modes: context_ref.inject_modes.clone(),
        }],
        truncated: false,
        total_count: 1,
    })
}

fn resolve_context_ref_from_vfs_source(
    vfs_db: &VfsDatabase,
    source_id: &str,
) -> Result<Option<ContextRef>, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    let (table_name, title_column) = if source_id.starts_with("file_")
        || source_id.starts_with("tb_")
        || source_id.starts_with("att_")
    {
        ("files", "file_name")
    } else if source_id.starts_with("fld_") {
        return Ok(None);
    } else {
        return Ok(None);
    };

    let sql = format!(
        r#"
        SELECT r.hash, t.{title}, COALESCE(t.type, ''), COALESCE(t.mime_type, '')
        FROM {table} t
        LEFT JOIN resources r ON t.resource_id = r.id
        WHERE t.id = ?1
          AND t.deleted_at IS NULL
          AND (r.deleted_at IS NULL OR r.id IS NULL)
        "#,
        title = title_column,
        table = table_name
    );

    let row_result: Result<(Option<String>, Option<String>, String, String), rusqlite::Error> =
        conn.query_row(&sql, rusqlite::params![source_id], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        });

    let (hash_opt, title_opt, file_type, mime_type) = match row_result {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let hash = hash_opt.unwrap_or_default();
    if hash.trim().is_empty() {
        return Ok(None);
    }

    let inferred_type_id = if file_type.eq_ignore_ascii_case("image")
        || mime_type.to_ascii_lowercase().starts_with("image/")
    {
        "image"
    } else {
        "file"
    };

    let mut context_ref =
        ContextRef::new(source_id.to_string(), hash, inferred_type_id.to_string());
    if let Some(title) = title_opt {
        if !title.trim().is_empty() {
            context_ref = context_ref.with_display_name(title);
        }
    }
    Ok(Some(context_ref))
}

fn resolve_deck_and_note_type(
    ctx: &ExecutionContext,
    deck_name: Option<String>,
    note_type: Option<String>,
) -> (String, String) {
    // Prefer explicit args; otherwise use settings; fallback to Default/Basic.
    let deck = deck_name.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    let note = note_type.and_then(|s| {
        let t = s.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });

    if deck.is_some() || note.is_some() {
        return (
            deck.unwrap_or_else(|| "Default".to_string()),
            note.unwrap_or_else(|| "Basic".to_string()),
        );
    }

    let db = ctx.main_db.as_ref().or(ctx.anki_db.as_ref());
    let deck_from_db = db
        .and_then(|d| d.get_setting("anki_connect_default_deck").ok().flatten())
        .filter(|s| !s.trim().is_empty());
    let note_from_db = db
        .and_then(|d| d.get_setting("anki_connect_default_model").ok().flatten())
        .filter(|s| !s.trim().is_empty());

    (
        deck_from_db.unwrap_or_else(|| "Default".to_string()),
        note_from_db.unwrap_or_else(|| "Basic".to_string()),
    )
}

struct TemplateSelection {
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
}

fn resolve_template_selection(
    ctx: &ExecutionContext,
    goal: &str,
    template_mode: &ChatAnkiTemplateMode,
    template_id: Option<String>,
    template_ids: Option<Vec<String>>,
) -> Result<TemplateSelection, String> {
    let db = ctx
        .main_db
        .as_ref()
        .or(ctx.anki_db.as_ref())
        .ok_or_else(|| "Anki database not available".to_string())?;

    match template_mode {
        ChatAnkiTemplateMode::Single => {
            let tid = template_id
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .ok_or_else(|| {
                    "templateMode=single 时必须提供 templateId（指定单个模板）".to_string()
                })?;
            let exists = db
                .get_custom_template_by_id(&tid)
                .map_err(|e| format!("加载模板失败: {}", e))?
                .is_some();
            if !exists {
                return Err(format!("指定模板不存在: {}", tid));
            }
            Ok(TemplateSelection {
                template_id: Some(tid),
                template_ids: None,
            })
        }
        ChatAnkiTemplateMode::Multiple => {
            let ids = collect_requested_template_ids(template_id, template_ids);
            if ids.is_empty() {
                return Err(
                    "templateMode=multiple 时必须提供非空 templateIds（或 templateId）".to_string(),
                );
            }
            for id in &ids {
                let exists = db
                    .get_custom_template_by_id(id)
                    .map_err(|e| format!("加载模板失败: {}", e))?
                    .is_some();
                if !exists {
                    return Err(format!("指定模板不存在: {}", id));
                }
            }
            Ok(TemplateSelection {
                template_id: None,
                template_ids: Some(ids),
            })
        }
        ChatAnkiTemplateMode::All => {
            let templates = db
                .get_all_custom_templates()
                .map_err(|e| format!("加载模板列表失败: {}", e))?;
            let active_templates: Vec<_> = templates.into_iter().filter(|t| t.is_active).collect();
            if active_templates.is_empty() {
                return Err("templateMode=all 但当前没有启用中的模板".to_string());
            }
            // 体验保护：用户目标明确是“选择题”时，避免 all 模式混入非选择题模板导致预览/导出风格混乱。
            if goal_prefers_choice_template(goal) {
                if let Some(choice_template_id) =
                    infer_template_id_from_goal(goal, &active_templates)
                {
                    return Ok(TemplateSelection {
                        template_id: Some(choice_template_id),
                        template_ids: None,
                    });
                }
            }
            let active_ids: Vec<String> = active_templates.into_iter().map(|t| t.id).collect();
            Ok(TemplateSelection {
                template_id: None,
                template_ids: Some(active_ids),
            })
        }
    }
}

fn looks_like_glossary_content(text: &str) -> bool {
    let lines: Vec<&str> = text
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .collect();
    if lines.len() < 40 {
        return false;
    }

    let mut entry_like = 0usize;
    for l in &lines {
        if is_glossary_entry_start(l) {
            entry_like += 1;
        }
    }

    (entry_like as f32 / lines.len() as f32) >= 0.45
}

fn is_glossary_entry_start(line: &str) -> bool {
    let l = line.trim();
    if l.is_empty() {
        return false;
    }
    if l.contains('：') || l.contains(':') {
        return true;
    }
    if l.starts_with("- ") || l.starts_with("* ") {
        return true;
    }
    // 1. xxx / 1) xxx / 1、xxx (rough heuristic; only used after glossary-mode detection)
    l.len() >= 3
        && l.chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
}

fn normalize_glossary_paragraphs(text: &str) -> String {
    let mut paragraphs: Vec<String> = Vec::new();
    let mut current = String::new();

    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            if !current.trim().is_empty() {
                paragraphs.push(current.trim().to_string());
                current.clear();
            }
            continue;
        }

        if is_glossary_entry_start(line) {
            if !current.trim().is_empty() {
                paragraphs.push(current.trim().to_string());
                current.clear();
            }
            current.push_str(line);
            continue;
        }

        if current.is_empty() {
            current.push_str(line);
        } else {
            current.push('\n');
            current.push_str(line);
        }
    }

    if !current.trim().is_empty() {
        paragraphs.push(current.trim().to_string());
    }

    // Ensure paragraph boundaries exist for the segmenter (\n\n split).
    paragraphs.join("\n\n")
}

fn build_generation_options(
    goal: &str,
    deck_name: &str,
    note_type: &str,
    content_text: &str,
    template: Option<&crate::models::CustomAnkiTemplate>,
    max_cards_override: Option<i32>,
) -> AnkiGenerationOptions {
    // Heuristic: glossary-like inputs (e.g. 120 term definitions) are prone to large single-shot outputs.
    // We bias toward smaller segments (less overlap) to reduce timeouts and missing items.
    let glossary_mode = looks_like_glossary_content(content_text);

    let (template_id, custom_anki_prompt, template_fields, field_extraction_rules) =
        if let Some(t) = template {
            let fields = normalize_template_fields(&t.fields);
            let rules = ensure_field_extraction_rules(&fields, &t.field_extraction_rules);
            let prompt = if t.generation_prompt.trim().is_empty() {
                None
            } else {
                Some(t.generation_prompt.clone())
            };
            (Some(t.id.clone()), prompt, Some(fields), Some(rules))
        } else {
            let fields = default_template_fields();
            let rules = ensure_field_extraction_rules(&fields, &HashMap::new());
            (None, None, Some(fields), Some(rules))
        };

    AnkiGenerationOptions {
        deck_name: deck_name.to_string(),
        note_type: note_type.to_string(),
        enable_images: false,
        // Cap to <=100 per EnhancedAnkiService validation; overall card count comes from segmentation/output.
        // For glossary-like content, avoid giving a low numeric target (e.g. 60) that can cause the
        // model to stop early when the user pasted 100+ entries. Let the content drive count.
        max_cards_per_mistake: max_cards_override.unwrap_or_else(|| {
            if glossary_mode {
                0 // 词汇表模式：不限制，由内容条目数决定
            } else {
                // 根据内容长度动态计算合理上限：
                // 短文本（<500字）→ 最多10张
                // 中等（500-2000字）→ 最多30张
                // 长文本（>2000字）→ 最多80张
                let char_count = content_text.chars().count();
                if char_count < 500 {
                    10
                } else if char_count < 2000 {
                    30
                } else {
                    80
                }
            }
        }),
        // ChatAnki 的 maxCards 语义是“整次制卡总上限”，不是“每段上限”。
        // 分段后会在 DocumentProcessingService 内按段分配，避免 10 -> 20 的放大。
        max_cards_total: max_cards_override,
        max_tokens: None,
        temperature: Some(if glossary_mode { 0.2 } else { 0.3 }),
        max_output_tokens_override: if glossary_mode { Some(2400) } else { None },
        temperature_override: None,
        template_id,
        custom_anki_prompt,
        template_fields,
        field_extraction_rules,
        template_fields_by_id: None,
        field_extraction_rules_by_id: None,
        // High-priority requirements (in system prompt).
        custom_requirements: Some(build_chatanki_requirements(goal)),
        segment_overlap_size: if glossary_mode { 0 } else { 200 },
        system_prompt: None,
        template_ids: None,
        template_descriptions: None,
        enable_llm_boundary_detection: Some(true),
    }
}

fn build_chatanki_requirements(goal: &str) -> String {
    // Keep it short; StreamingAnkiService will add delimiter/JSON formatting requirements.
    format!(
        "学习目标：{goal}\n\
规则：\n\
- 每张卡只测试一个知识点（最小信息原则），避免“一卡多问”。\n\
- 若内容是“术语/名词解释/概念清单”形式：默认 **每条条目生成 1 张卡**（front=术语/问题，back=解释），不要遗漏，也不要把一条条目拆成多张（除非该条非常长且确有必要）。\n\
- 优先覆盖内容中的所有条目/小点（尤其是名词解释/术语列表），不要遗漏。\n\
- 正面问题要清晰可回忆；背面答案要简洁但不丢关键限定条件。\n\
- tags 给 0~3 个关键词（可为空数组）。"
    )
}

fn default_template_fields() -> Vec<String> {
    vec!["front".to_string(), "back".to_string(), "tags".to_string()]
}

pub(crate) fn normalize_template_fields(fields: &[String]) -> Vec<String> {
    if fields.is_empty() {
        default_template_fields()
    } else {
        fields.to_vec()
    }
}

fn build_default_field_rule(field: &str) -> FieldExtractionRule {
    let lower = field.to_lowercase();
    FieldExtractionRule {
        field_type: if lower == "tags" {
            FieldType::Array
        } else {
            FieldType::Text
        },
        is_required: lower == "front" || lower == "back",
        default_value: if lower == "tags" {
            Some("[]".to_string())
        } else {
            None
        },
        validation_pattern: None,
        description: field.to_string(),
        validation: None,
        transform: None,
        schema: None,
        item_schema: None,
        display_format: None,
        ai_hint: None,
        max_length: None,
        min_length: None,
        allowed_values: None,
        depends_on: None,
        compute_function: None,
    }
}

pub(crate) fn ensure_field_extraction_rules(
    fields: &[String],
    rules: &HashMap<String, FieldExtractionRule>,
) -> HashMap<String, FieldExtractionRule> {
    let normalized_fields = normalize_template_fields(fields);
    let mut filled = rules.clone();
    for field in normalized_fields.iter() {
        if !filled.contains_key(field) {
            filled.insert(field.clone(), build_default_field_rule(field));
        }
    }
    if filled.is_empty() {
        default_field_extraction_rules()
    } else {
        filled
    }
}

pub(crate) fn calculate_complexity_level(fields_len: usize, note_type: &str) -> &'static str {
    let is_cloze = note_type.eq_ignore_ascii_case("Cloze");
    if fields_len <= 2 && !is_cloze {
        return "simple";
    }
    if fields_len <= 4 {
        return "moderate";
    }
    if fields_len <= 6 {
        return "complex";
    }
    "very_complex"
}

fn default_field_extraction_rules() -> HashMap<String, FieldExtractionRule> {
    let mut rules = HashMap::new();
    rules.insert(
        "front".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: true,
            default_value: None,
            validation_pattern: None,
            description: "Front".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules.insert(
        "back".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: true,
            default_value: None,
            validation_pattern: None,
            description: "Back".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules.insert(
        "tags".to_string(),
        FieldExtractionRule {
            field_type: FieldType::Array,
            is_required: false,
            default_value: Some("[]".to_string()),
            validation_pattern: None,
            description: "Tags".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: None,
            min_length: None,
            allowed_values: None,
            depends_on: None,
            compute_function: None,
        },
    );
    rules
}

pub(crate) fn import_builtin_templates_if_empty(
    db: &crate::database::Database,
) -> Result<usize, String> {
    const BUILTIN_TEMPLATES_JSON: &str = include_str!("../../data/builtin-templates.json");
    let templates: Vec<Value> = serde_json::from_str(BUILTIN_TEMPLATES_JSON)
        .map_err(|e| format!("Parse builtin templates failed: {}", e))?;
    let mut imported = 0usize;

    for template_value in templates {
        let template_id = template_value
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if template_id.is_empty() {
            continue;
        }
        if let Ok(Some(_)) = db.get_custom_template_by_id(&template_id) {
            continue;
        }

        let fields: Vec<String> = template_value
            .get("fields_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| {
                template_value
                    .get("fields")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
            })
            .unwrap_or_default();
        let field_extraction_rules: HashMap<String, FieldExtractionRule> = template_value
            .get("field_extraction_rules_json")
            .and_then(|v| v.as_str())
            .and_then(|s| serde_json::from_str(s).ok())
            .or_else(|| {
                template_value
                    .get("field_extraction_rules")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
            })
            .unwrap_or_default();
        let normalized_fields = normalize_template_fields(&fields);
        let normalized_rules =
            ensure_field_extraction_rules(&normalized_fields, &field_extraction_rules);

        let create_request = CreateTemplateRequest {
            name: template_value
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("未命名模板")
                .to_string(),
            description: template_value
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            author: template_value
                .get("author")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
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
            fields: normalized_fields,
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
            field_extraction_rules: normalized_rules,
            preview_data_json: template_value
                .get("preview_data_json")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string()),
            is_active: Some(true),
            is_built_in: Some(true),
        };

        if db
            .create_custom_template_with_id(&template_id, &create_request)
            .is_ok()
        {
            imported += 1;
        }
    }

    Ok(imported)
}

fn convert_backend_card(c: &crate::models::AnkiCard) -> Value {
    let extra_fields = c.extra_fields.clone();
    let fields = extra_fields.clone();
    json!({
        "id": c.id,
        "task_id": c.task_id,
        "front": c.front,
        "back": c.back,
        "text": c.text,
        "tags": c.tags,
        "images": c.images,
        "fields": fields,
        "extra_fields": extra_fields,
        "template_id": c.template_id,
        "is_error_card": c.is_error_card,
        "error_content": c.error_content,
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    })
}

fn goal_prefers_choice_template(goal: &str) -> bool {
    let g = goal.to_lowercase();
    ["选择题", "单选", "多选", "choice", "multiple choice"]
        .iter()
        .any(|kw| g.contains(kw))
}

fn infer_template_id_from_goal(
    goal: &str,
    templates: &[crate::models::CustomAnkiTemplate],
) -> Option<String> {
    if !goal_prefers_choice_template(goal) {
        return None;
    }

    let mut best: Option<(&crate::models::CustomAnkiTemplate, usize)> = None;

    for t in templates.iter().filter(|t| t.is_active) {
        let field_set: std::collections::HashSet<String> =
            t.fields.iter().map(|f| f.trim().to_lowercase()).collect();
        let choice_fields = ["question", "optiona", "optionb", "optionc", "optiond"];
        let score = choice_fields
            .iter()
            .filter(|f| field_set.contains(**f))
            .count();
        if score >= 4 {
            if let Some((_, best_score)) = best {
                if score > best_score {
                    best = Some((t, score));
                }
            } else {
                best = Some((t, score));
            }
        }
    }

    best.map(|(t, _)| t.id.clone())
}

fn distribute_global_max_cards(total: i32, segments: usize) -> Vec<i32> {
    if segments == 0 {
        return Vec::new();
    }
    if total <= 0 {
        return vec![0; segments];
    }
    let total_usize = total as usize;
    let base = total_usize / segments;
    let remainder = total_usize % segments;
    (0..segments)
        .map(|idx| {
            let extra = if idx < remainder { 1 } else { 0 };
            (base + extra) as i32
        })
        .collect()
}

fn derive_status_snapshot(
    tasks: &[crate::models::DocumentTask],
    cards_len: usize,
) -> (String, Option<String>, bool) {
    let is_paused = tasks
        .iter()
        .any(|t| matches!(t.status, crate::models::TaskStatus::Paused));
    let is_in_progress = tasks.iter().any(|t| {
        matches!(
            t.status,
            crate::models::TaskStatus::Pending
                | crate::models::TaskStatus::Processing
                | crate::models::TaskStatus::Streaming
        )
    });
    let has_failed_or_truncated = tasks.iter().any(|t| {
        matches!(
            t.status,
            crate::models::TaskStatus::Failed | crate::models::TaskStatus::Truncated
        )
    });
    let has_cancelled = tasks
        .iter()
        .any(|t| matches!(t.status, crate::models::TaskStatus::Cancelled));
    let status = if tasks.is_empty() && cards_len == 0 {
        "not_found".to_string()
    } else if is_in_progress {
        "running".to_string()
    } else if is_paused {
        "paused".to_string()
    } else if has_cancelled {
        "cancelled".to_string()
    } else if has_failed_or_truncated {
        "completed_with_errors".to_string()
    } else {
        "completed".to_string()
    };
    let error = if status == "not_found" {
        Some("blocks.ankiCards.errors.statusNotFound".to_string())
    } else {
        None
    };
    let should_retry = status == "not_found";
    (status, error, should_retry)
}

fn decide_wait_timeout_status(
    block_ever_found: bool,
    document_wait_available: bool,
    timeout_ms: u64,
) -> (String, Option<String>) {
    if !block_ever_found && !document_wait_available {
        // By the deadline we still never saw the block, and we also don't have a
        // stable documentId path to fall back to.
        // For very small timeouts, "not_found" is usually a false alarm (the block
        // may exist but hasn't been persisted/visible yet). Return "timeout" instead.
        if timeout_ms < 5_000 {
            (
                "timeout".to_string(),
                Some("blocks.ankiCards.errors.waitTimeout".to_string()),
            )
        } else {
            (
                "not_found".to_string(),
                Some("blocks.ankiCards.errors.waitNotFound".to_string()),
            )
        }
    } else {
        ("timeout".to_string(), None)
    }
}

fn compute_task_counts(tasks: &[crate::models::DocumentTask]) -> Value {
    let total = tasks.len() as u32;
    let mut counts = serde_json::Map::new();
    let mut completed = 0u32;
    let mut failed = 0u32;
    let mut truncated = 0u32;
    let mut paused = 0u32;
    let mut processing = 0u32;
    let mut streaming = 0u32;
    let mut pending = 0u32;
    let mut cancelled = 0u32;

    for task in tasks.iter() {
        match task.status {
            crate::models::TaskStatus::Pending => pending += 1,
            crate::models::TaskStatus::Processing => processing += 1,
            crate::models::TaskStatus::Streaming => streaming += 1,
            crate::models::TaskStatus::Paused => paused += 1,
            crate::models::TaskStatus::Completed => completed += 1,
            crate::models::TaskStatus::Failed => failed += 1,
            crate::models::TaskStatus::Truncated => truncated += 1,
            crate::models::TaskStatus::Cancelled => cancelled += 1,
        }
    }

    counts.insert("total".to_string(), json!(total));
    counts.insert("pending".to_string(), json!(pending));
    counts.insert("processing".to_string(), json!(processing));
    counts.insert("streaming".to_string(), json!(streaming));
    counts.insert("paused".to_string(), json!(paused));
    counts.insert("completed".to_string(), json!(completed));
    counts.insert("failed".to_string(), json!(failed));
    counts.insert("truncated".to_string(), json!(truncated));
    counts.insert("cancelled".to_string(), json!(cancelled));

    let completed_ratio = if total > 0 {
        completed as f32 / total as f32
    } else {
        0.0
    };

    json!({
        "counts": counts,
        "completedRatio": completed_ratio,
    })
}

fn emit_anki_cards_chunk(
    emitter: &crate::chat_v2::events::ChatV2EventEmitter,
    block_id: &str,
    update: Value,
) {
    let chunk = match serde_json::to_string(&update) {
        Ok(s) => s,
        Err(_) => return,
    };
    emitter.emit_chunk(event_types::ANKI_CARDS, block_id, &chunk, None);
}

fn emit_anki_cards_error(
    emitter: &crate::chat_v2::events::ChatV2EventEmitter,
    block_id: &str,
    error: &str,
) {
    emitter.emit_error(event_types::ANKI_CARDS, block_id, error, None);
}

fn deep_merge_value(into: &mut Value, patch: Value) {
    match (into, patch) {
        (Value::Object(into_map), Value::Object(patch_map)) => {
            for (k, v) in patch_map {
                match into_map.get_mut(&k) {
                    Some(existing) => deep_merge_value(existing, v),
                    None => {
                        into_map.insert(k, v);
                    }
                }
            }
        }
        (into_slot, patch_value) => {
            *into_slot = patch_value;
        }
    }
}

fn persist_anki_cards_running_patch(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    fallback_message_id: &str,
    block_id: &str,
    tool_name: &str,
    patch: Value,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Best-effort: preserve message_id/tool_output/timestamps from existing row if present.
    let existing = ChatV2Repo::get_block_v2(chat_db, block_id).ok().flatten();
    let message_id = existing
        .as_ref()
        .map(|b| b.message_id.clone())
        .unwrap_or_else(|| fallback_message_id.to_string());

    let started_at = existing
        .as_ref()
        .and_then(|b| b.started_at)
        .unwrap_or(now_ms);
    let first_chunk_at = existing
        .as_ref()
        .and_then(|b| b.first_chunk_at)
        .unwrap_or(now_ms);

    let mut tool_output = existing
        .as_ref()
        .and_then(|b| b.tool_output.clone())
        .unwrap_or_else(|| json!({ "cards": [], "documentId": null }));
    deep_merge_value(&mut tool_output, patch);

    let block = MessageBlock {
        id: block_id.to_string(),
        message_id,
        block_type: block_types::ANKI_CARDS.to_string(),
        status: block_status::RUNNING.to_string(),
        content: None,
        tool_name: Some(tool_name.to_string()),
        tool_input: None,
        tool_output: Some(tool_output),
        citations: None,
        error: None,
        started_at: Some(started_at),
        ended_at: None,
        first_chunk_at: Some(first_chunk_at),
        block_index: 1,
    };

    let _ = upsert_block_allow_orphan(chat_db, &block);
}

fn persist_anki_cards_terminal_block(
    chat_db: &crate::chat_v2::database::ChatV2Database,
    fallback_message_id: &str,
    block_id: &str,
    tool_name: &str,
    status: &str,
    tool_output_override: Option<Value>,
    error: Option<String>,
) {
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Best-effort: preserve message_id/tool_output from existing row if present.
    let existing = ChatV2Repo::get_block_v2(chat_db, block_id).ok().flatten();
    let message_id = existing
        .as_ref()
        .map(|b| b.message_id.clone())
        .unwrap_or_else(|| fallback_message_id.to_string());
    let tool_output = tool_output_override
        .or_else(|| existing.and_then(|b| b.tool_output))
        .or_else(|| {
            // Minimal shape so UI doesn't explode after refresh.
            Some(json!({ "cards": [], "documentId": null }))
        });

    let block = MessageBlock {
        id: block_id.to_string(),
        message_id,
        block_type: block_types::ANKI_CARDS.to_string(),
        status: status.to_string(),
        content: None,
        tool_name: Some(tool_name.to_string()),
        tool_input: None,
        tool_output,
        citations: None,
        error,
        started_at: Some(now_ms),
        ended_at: Some(now_ms),
        first_chunk_at: Some(now_ms),
        block_index: 1,
    };

    let _ = upsert_block_allow_orphan(chat_db, &block);
}

fn upsert_block_allow_orphan(
    db: &crate::chat_v2::database::ChatV2Database,
    block: &MessageBlock,
) -> Result<(), String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

    let tool_input_json = block
        .tool_input
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| e.to_string())?;
    let tool_output_json = block
        .tool_output
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| e.to_string())?;
    let citations_json = block
        .citations
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()
        .map_err(|e| e.to_string())?;

    // Streaming path: message may not be saved yet; allow orphan blocks.
    conn.execute("PRAGMA foreign_keys = OFF", [])
        .map_err(|e| e.to_string())?;

    let result = conn.execute(
        r#"
        INSERT OR REPLACE INTO chat_v2_blocks
        (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        "#,
        rusqlite::params![
            block.id,
            block.message_id,
            block.block_type,
            block.status,
            block.block_index,
            block.content,
            block.tool_name,
            tool_input_json,
            tool_output_json,
            citations_json,
            block.error,
            block.started_at,
            block.ended_at,
            block.first_chunk_at,
        ],
    );

    let _ = conn.execute("PRAGMA foreign_keys = ON", []);
    result.map_err(|e| e.to_string())?;

    // Best-effort append block_id to message if message already exists.
    let _ = append_block_id_to_message(&conn, &block.message_id, &block.id);

    Ok(())
}

fn append_block_id_to_message(
    conn: &Connection,
    message_id: &str,
    block_id: &str,
) -> Result<(), String> {
    let existing_block_ids: Result<Option<String>, _> = conn.query_row(
        "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
        rusqlite::params![message_id],
        |row| row.get(0),
    );

    match existing_block_ids {
        Ok(block_ids_json) => {
            let mut block_ids: Vec<String> = block_ids_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            if !block_ids.contains(&block_id.to_string()) {
                block_ids.push(block_id.to_string());
                let updated = serde_json::to_string(&block_ids).map_err(|e| e.to_string())?;
                conn.execute(
                    "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                    rusqlite::params![updated, message_id],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // Streaming: message may not exist yet.
        }
        Err(e) => return Err(e.to_string()),
    }

    Ok(())
}

// ============================================================================
// Unit tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{DocumentTask, TaskStatus};
    use crate::vfs::types::{VfsContextRefData, VfsResourceRef, VfsResourceType};

    fn make_task(status: TaskStatus) -> DocumentTask {
        DocumentTask {
            id: format!("task-{:?}", status),
            document_id: "doc-1".to_string(),
            original_document_name: "doc-1".to_string(),
            segment_index: 0,
            content_segment: "segment".to_string(),
            status,
            created_at: "2026-02-01T00:00:00Z".to_string(),
            updated_at: "2026-02-01T00:00:00Z".to_string(),
            error_message: None,
            anki_generation_options_json: "{}".to_string(),
        }
    }

    fn make_ref(resource_type: VfsResourceType) -> VfsResourceRef {
        VfsResourceRef {
            source_id: format!("src-{:?}", resource_type),
            resource_hash: "hash".to_string(),
            resource_type,
            name: "ref".to_string(),
            inject_modes: None,
        }
    }

    #[test]
    fn test_can_handle() {
        let executor = ChatAnkiToolExecutor::new();
        assert!(executor.can_handle("builtin-chatanki_run"));
        assert!(executor.can_handle("mcp_chatanki_run"));
        assert!(executor.can_handle("chatanki_run"));
        assert!(executor.can_handle("builtin-chatanki_start"));
        assert!(executor.can_handle("builtin-chatanki_status"));
        assert!(executor.can_handle("builtin-chatanki_wait"));
        assert!(executor.can_handle("builtin-chatanki_control"));
        assert!(executor.can_handle("builtin-chatanki_export"));
        assert!(executor.can_handle("builtin-chatanki_sync"));
        assert!(executor.can_handle("builtin-chatanki_list_templates"));
        assert!(executor.can_handle("builtin-chatanki_analyze"));
        assert!(executor.can_handle("builtin-chatanki_check_anki_connect"));
        assert!(!executor.can_handle("builtin-anki_generate_cards"));
    }

    #[test]
    fn test_derive_status_snapshot_not_found() {
        let (status, error, should_retry) = derive_status_snapshot(&[], 0);
        assert_eq!(status, "not_found");
        assert_eq!(
            error,
            Some("blocks.ankiCards.errors.statusNotFound".to_string())
        );
        assert!(should_retry);
    }

    #[test]
    fn test_derive_status_snapshot_running_and_completed_with_errors() {
        let (status_running, error_running, should_retry_running) =
            derive_status_snapshot(&[make_task(TaskStatus::Pending)], 0);
        assert_eq!(status_running, "running");
        assert!(error_running.is_none());
        assert!(!should_retry_running);

        let (status_error, error_error, should_retry_error) =
            derive_status_snapshot(&[make_task(TaskStatus::Failed)], 2);
        assert_eq!(status_error, "completed_with_errors");
        assert!(error_error.is_none());
        assert!(!should_retry_error);
    }

    #[test]
    fn test_derive_status_snapshot_cancelled() {
        let (status, error, should_retry) =
            derive_status_snapshot(&[make_task(TaskStatus::Cancelled)], 1);
        assert_eq!(status, "cancelled");
        assert!(error.is_none());
        assert!(!should_retry);
    }

    #[test]
    fn test_decide_wait_timeout_status_variants() {
        let (status_short, error_short) = decide_wait_timeout_status(false, false, 3_000);
        assert_eq!(status_short, "timeout");
        assert_eq!(
            error_short,
            Some("blocks.ankiCards.errors.waitTimeout".to_string())
        );

        let (status_long, error_long) = decide_wait_timeout_status(false, false, 8_000);
        assert_eq!(status_long, "not_found");
        assert_eq!(
            error_long,
            Some("blocks.ankiCards.errors.waitNotFound".to_string())
        );

        let (status_available, error_available) = decide_wait_timeout_status(true, true, 8_000);
        assert_eq!(status_available, "timeout");
        assert!(error_available.is_none());
    }

    #[test]
    fn test_decide_route_heuristics() {
        let simple_refs = VfsContextRefData {
            refs: vec![make_ref(VfsResourceType::File)],
            truncated: false,
            total_count: 1,
        };
        assert_eq!(decide_route(&simple_refs), ChatAnkiRoute::SimpleText);

        let light_refs = VfsContextRefData {
            refs: vec![
                make_ref(VfsResourceType::File),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
            ],
            truncated: false,
            total_count: 3,
        };
        assert_eq!(decide_route(&light_refs), ChatAnkiRoute::VlmLight);

        let full_refs = VfsContextRefData {
            refs: vec![
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
                make_ref(VfsResourceType::Image),
            ],
            truncated: false,
            total_count: 4,
        };
        assert_eq!(decide_route(&full_refs), ChatAnkiRoute::VlmFull);
    }

    #[test]
    fn test_distribute_global_max_cards() {
        assert_eq!(distribute_global_max_cards(10, 2), vec![5, 5]);
        assert_eq!(distribute_global_max_cards(10, 3), vec![4, 3, 3]);
        assert_eq!(distribute_global_max_cards(2, 5), vec![1, 1, 0, 0, 0]);
    }

    #[test]
    fn test_goal_prefers_choice_template() {
        assert!(goal_prefers_choice_template("请制作10张高中生物选择题卡片"));
        assert!(goal_prefers_choice_template("做一组单选题复习"));
        assert!(!goal_prefers_choice_template("生成术语词典卡片"));
    }

    #[test]
    fn test_resolve_single_template_id() {
        assert_eq!(
            resolve_single_template_id(Some(" design-manuscript ")),
            Some("design-manuscript")
        );
        assert_eq!(resolve_single_template_id(Some("   ")), None);
        assert_eq!(resolve_single_template_id(None), None);
    }

    #[test]
    fn test_collect_requested_template_ids() {
        let ids = collect_requested_template_ids(
            Some(" template-b ".to_string()),
            Some(vec![
                "template-a".to_string(),
                "template-b".to_string(),
                "template-c,template-a".to_string(),
            ]),
        );
        assert_eq!(ids, vec!["template-a", "template-b", "template-c"]);
    }

    #[test]
    fn test_chatanki_run_args_accept_string_max_cards_and_resource_ids() {
        let args: ChatAnkiRunArgs = serde_json::from_value(serde_json::json!({
            "goal": "test",
            "templateMode": "all",
            "maxCards": "10",
            "resourceId": "file_a",
            "resourceIds": ["file_b", "file_c"]
        }))
        .expect("should parse run args");

        assert_eq!(args.max_cards, Some(10));
        assert_eq!(args.resource_id.as_deref(), Some("file_a"));
        assert_eq!(args.resource_ids.unwrap_or_default().len(), 2);
    }

    #[test]
    fn test_build_single_ref_data_from_context_ref_respects_image_type() {
        let context_ref = ContextRef::new(
            "att_image_1".to_string(),
            "hash_1".to_string(),
            "image".to_string(),
        )
        .with_display_name("img".to_string());

        let ref_data = build_single_ref_data_from_context_ref(&context_ref)
            .expect("should build single ref data");
        assert_eq!(ref_data.refs.len(), 1);
        assert_eq!(ref_data.refs[0].resource_type, VfsResourceType::Image);
    }

    #[test]
    fn test_derive_effective_template_mode() {
        let single = TemplateSelection {
            template_id: Some("template-a".to_string()),
            template_ids: Some(vec!["template-a".to_string(), "template-b".to_string()]),
        };
        assert_eq!(
            derive_effective_template_mode(&single).as_str(),
            ChatAnkiTemplateMode::Single.as_str()
        );

        let multiple = TemplateSelection {
            template_id: None,
            template_ids: Some(vec!["template-a".to_string(), "template-b".to_string()]),
        };
        assert_eq!(
            derive_effective_template_mode(&multiple).as_str(),
            ChatAnkiTemplateMode::Multiple.as_str()
        );
    }
}
