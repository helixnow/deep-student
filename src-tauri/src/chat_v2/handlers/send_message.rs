//! 消息发送相关命令处理器
//!
//! 包含发送消息、取消流式生成、重试消息、编辑并重发、继续执行等命令。

use std::sync::Arc;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{Emitter, State, Window};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::events::ChatV2EventEmitter;
use crate::chat_v2::pipeline::ChatV2Pipeline;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::resource_types::{ContentBlock, ContextRef, ContextSnapshot, SendContextRef};
use crate::chat_v2::state::{ChatV2State, StreamGuard};
use crate::chat_v2::tools::todo_executor::{load_persisted_todo_list, restore_todo_list_from_db};
use crate::chat_v2::types::{
    variant_status, AttachmentMeta, ChatMessage, MessageRole, SendMessageRequest, SendOptions,
};
use crate::chat_v2::user_message_builder::create_user_refs_snapshot;
// 🆕 VFS 统一存储（2025-12-07）：资源操作使用 vfs.db
use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsResourceRepo;
use crate::vfs::types::{ImageInjectMode, PdfInjectMode, ResourceInjectModes, VfsContextRefData};

/// ★ 2026-01-26：根据模型 ID 判断是否支持多模态
///
/// 从 LLMManager 获取模型配置，返回 is_multimodal 属性。
/// 当 model_id 为空时，回退到默认对话模型再判断，避免误降级为文本模式。
async fn is_model_multimodal(llm_manager: &LLMManager, model_id: Option<&str>) -> bool {
    let explicit_model_id = model_id.and_then(|id| {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });

    if let Some(model_id) = explicit_model_id {
        return match llm_manager.get_api_configs().await {
            Ok(configs) => {
                // 先通过 config.id 匹配，再通过 config.model 匹配
                configs
                    .iter()
                    .find(|c| c.id.as_str() == model_id || c.model.as_str() == model_id)
                    .map(|c| c.is_multimodal)
                    .unwrap_or(false)
            }
            Err(e) => {
                log::warn!(
                    "[ChatV2::handlers] Failed to get API configs for is_multimodal check: {}",
                    e
                );
                false
            }
        };
    }

    // 当请求未显式传 model_id 时，回退到默认对话模型，避免误判为文本模型
    match llm_manager
        .select_model_for("default", None, None, None, None, None, None)
        .await
    {
        Ok((config, _)) => config.is_multimodal,
        Err(e) => {
            log::warn!(
                "[ChatV2::handlers] Failed to resolve default model for is_multimodal check: {}",
                e
            );
            false
        }
    }
}

#[derive(Debug, Serialize)]
pub struct RetryMessageResult {
    pub message_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deleted_message_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deleted_variant_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_variant_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct EditAndResendResult {
    pub new_message_id: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub deleted_message_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_variant_id: Option<String>,
}

fn mode_selected_image(inject_modes: &Option<ResourceInjectModes>) -> bool {
    inject_modes
        .as_ref()
        .map(|m| {
            m.image
                .as_ref()
                .map(|modes| modes.contains(&ImageInjectMode::Image))
                .unwrap_or(false)
                || m.pdf
                    .as_ref()
                    .map(|modes| modes.contains(&PdfInjectMode::Image))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn mode_selected_ocr(inject_modes: &Option<ResourceInjectModes>) -> bool {
    inject_modes
        .as_ref()
        .map(|m| {
            m.image
                .as_ref()
                .map(|modes| modes.contains(&ImageInjectMode::Ocr))
                .unwrap_or(false)
                || m.pdf
                    .as_ref()
                    .map(|modes| modes.contains(&PdfInjectMode::Ocr))
                    .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn image_modes_to_strings(inject_modes: &Option<ResourceInjectModes>) -> Vec<&'static str> {
    inject_modes
        .as_ref()
        .and_then(|m| m.image.as_ref())
        .map(|modes| {
            modes
                .iter()
                .map(|mode| match mode {
                    ImageInjectMode::Image => "image",
                    ImageInjectMode::Ocr => "ocr",
                })
                .collect()
        })
        .unwrap_or_default()
}

fn pdf_modes_to_strings(inject_modes: &Option<ResourceInjectModes>) -> Vec<&'static str> {
    inject_modes
        .as_ref()
        .and_then(|m| m.pdf.as_ref())
        .map(|modes| {
            modes
                .iter()
                .map(|mode| match mode {
                    PdfInjectMode::Text => "text",
                    PdfInjectMode::Ocr => "ocr",
                    PdfInjectMode::Image => "image",
                })
                .collect()
        })
        .unwrap_or_default()
}

fn build_backend_request_audit_payload(
    request: &SendMessageRequest,
    model_id: Option<&str>,
    is_multimodal_model: bool,
) -> Value {
    let refs = request.user_context_refs.as_deref().unwrap_or(&[]);
    let mut total_text_blocks = 0usize;
    let mut total_image_blocks = 0usize;
    let mut has_image_mode = false;
    let mut has_ocr_mode = false;
    let mut ref_items: Vec<Value> = Vec::with_capacity(refs.len());

    for r in refs {
        let mut text_blocks = 0usize;
        let mut image_blocks = 0usize;
        for block in &r.formatted_blocks {
            match block {
                ContentBlock::Text { .. } => text_blocks += 1,
                ContentBlock::Image { .. } => image_blocks += 1,
            }
        }
        total_text_blocks += text_blocks;
        total_image_blocks += image_blocks;

        if mode_selected_image(&r.inject_modes) {
            has_image_mode = true;
        }
        if mode_selected_ocr(&r.inject_modes) {
            has_ocr_mode = true;
        }

        ref_items.push(json!({
            "resourceId": r.resource_id,
            "typeId": r.type_id,
            "displayName": r.display_name,
            "injectModes": {
                "image": image_modes_to_strings(&r.inject_modes),
                "pdf": pdf_modes_to_strings(&r.inject_modes),
            },
            "blocks": {
                "total": r.formatted_blocks.len(),
                "text": text_blocks,
                "image": image_blocks,
            },
        }));
    }

    // ★ 2026-02-13 修复：纯文本模型 + 图片/文件附件 → OCR 始终被期望
    // resolveVfsRefs 会为纯文本模型归一化 injectModes 强制包含 OCR
    let has_image_or_file_ref = refs
        .iter()
        .any(|r| r.type_id == "image" || r.type_id == "file");
    let text_model_implies_ocr = !is_multimodal_model && has_image_or_file_ref;

    let expected_image_blocks = is_multimodal_model && has_image_mode;
    let expected_ocr_text = has_ocr_mode || text_model_implies_ocr;
    let mut mismatch_reasons: Vec<&str> = Vec::new();
    if expected_image_blocks && total_image_blocks == 0 {
        mismatch_reasons.push("selected_image_mode_but_no_image_blocks");
    }
    if expected_ocr_text && total_text_blocks == 0 {
        mismatch_reasons.push("selected_ocr_mode_but_no_text_blocks");
    }
    if !is_multimodal_model && has_image_mode && total_image_blocks > 0 {
        mismatch_reasons.push("text_model_received_image_blocks");
    }
    if text_model_implies_ocr && total_text_blocks == 0 {
        mismatch_reasons.push("text_model_expected_ocr_but_no_text_blocks");
    }

    json!({
        "source": "backend",
        "sessionId": request.session_id,
        "modelId": model_id,
        "isMultimodalModel": is_multimodal_model,
        "contentLength": request.content.chars().count(),
        "refCount": refs.len(),
        "pathMapCount": request.path_map.as_ref().map(|m| m.len()).unwrap_or(0),
        "blockTotals": {
            "total": total_text_blocks + total_image_blocks,
            "text": total_text_blocks,
            "image": total_image_blocks,
        },
        "refs": ref_items,
        "expectation": {
            "expectedImageBlocks": expected_image_blocks,
            "expectedOcrText": expected_ocr_text,
            "expectationMet": mismatch_reasons.is_empty(),
            "mismatchReasons": mismatch_reasons,
        },
    })
}

/// 发送消息并启动流式生成
///
/// 该命令会立即返回 assistant_message_id，然后在后台异步执行流水线。
/// 前端通过监听 `chat_v2_event_{session_id}` 和 `chat_v2_session_{session_id}` 事件接收更新。
///
/// ## 参数
/// - `request`: 发送消息请求，包含会话 ID、消息内容、附件和选项
/// - `window`: Tauri 窗口句柄，用于发射事件
/// - `state`: 应用状态
/// - `chat_v2_state`: Chat V2 专用状态
///
/// ## 返回
/// - `Ok(String)`: 返回 assistant_message_id
/// - `Err(String)`: 错误信息
///
/// ## 事件
/// - `chat_v2_session_{session_id}`: stream_start 事件
/// - `chat_v2_event_{session_id}`: 块级事件（start/chunk/end/error）
/// - `chat_v2_session_{session_id}`: stream_complete/stream_error 事件
#[tauri::command]
pub async fn chat_v2_send_message(
    request: SendMessageRequest,
    window: Window,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<String, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_send_message: session_id={}, content_len={}",
        request.session_id,
        request.content.len()
    );

    // 🔍 调试日志：检查 mcp_tool_schemas 是否被正确传递
    if let Some(ref options) = request.options {
        let mcp_tool_count = options
            .mcp_tool_schemas
            .as_ref()
            .map(|s| s.len())
            .unwrap_or(0);
        log::info!(
            "[ChatV2::handlers] 📦 SendOptions received: mcp_tool_schemas={}, mcp_tools={:?}, has_options=true",
            mcp_tool_count,
            options.mcp_tools.as_ref().map(|t| t.len())
        );
        if mcp_tool_count > 0 {
            if let Some(ref schemas) = options.mcp_tool_schemas {
                let tool_names: Vec<&str> =
                    schemas.iter().take(5).map(|s| s.name.as_str()).collect();
                log::info!(
                    "[ChatV2::handlers] 📦 First 5 tool names: {:?} (total: {})",
                    tool_names,
                    schemas.len()
                );
            }
        } else {
            log::warn!("[ChatV2::handlers] ⚠️ mcp_tool_schemas is empty or None!");
        }
        // 🔍 诊断：检查 active_skill_ids 和 skill_contents 是否被正确传递
        log::info!(
            "[ChatV2::handlers] 📦 Skills diag: active_skill_ids={:?}, skill_contents_keys={:?}",
            options.active_skill_ids.as_ref().map(|ids| ids.as_slice()),
            options
                .skill_contents
                .as_ref()
                .map(|sc| sc.keys().collect::<Vec<_>>())
        );
    } else {
        log::warn!("[ChatV2::handlers] ⚠️ SendOptions is None!");
    }

    // ★ 2025-12-10 统一改造：验证请求（附件现在通过 user_context_refs 传递）
    let has_content = !request.content.trim().is_empty();
    let has_context_refs = request
        .user_context_refs
        .as_ref()
        .map_or(false, |refs| !refs.is_empty());
    if !has_content && !has_context_refs {
        return Err(ChatV2Error::Validation(
            "Message content or context refs required".to_string(),
        )
        .into());
    }

    let model_id = request.options.as_ref().and_then(|o| o.model_id.as_deref());
    let is_multimodal_model = is_model_multimodal(&llm_manager, model_id).await;
    let request_audit_payload =
        build_backend_request_audit_payload(&request, model_id, is_multimodal_model);
    if let Err(e) = window.emit("chat_v2_request_audit", &request_audit_payload) {
        log::warn!(
            "[ChatV2::handlers] Failed to emit chat_v2_request_audit event: {}",
            e
        );
    }

    // 确保 assistant_message_id 存在，如果前端没有提供则由 Handler 生成
    // 这样可以保证返回值与 Pipeline 实际使用的 ID 一致
    let assistant_message_id = request
        .assistant_message_id
        .clone()
        .unwrap_or_else(|| ChatMessage::generate_id());

    // 构建带有确定 ID 的请求
    let request_with_id = SendMessageRequest {
        assistant_message_id: Some(assistant_message_id.clone()),
        ..request
    };

    // 🔒 P0 修复（2026-01-11）：使用原子操作检查并注册流
    // 避免并发请求同时通过检查导致多个流被创建
    let cancel_token = match chat_v2_state.try_register_stream(&request_with_id.session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Session has an active stream. Please wait for completion or cancel first."
                    .to_string(),
            )
            .into());
        }
    };

    // 克隆必要的数据用于异步任务
    let session_id = request_with_id.session_id.clone();
    let session_id_for_cleanup = session_id.clone();
    let window_clone = window.clone();
    let pipeline_clone = pipeline.inner().clone();
    let chat_v2_state_clone = chat_v2_state.inner().clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务，确保优雅关闭
    // 异步执行流水线
    // 🔧 P1修复：传递 chat_v2_state 给 Pipeline，用于注册每个变体的 cancel token
    chat_v2_state.spawn_tracked(async move {
        // 🔧 Panic guard: RAII 确保 remove_stream 在正常完成、取消或 panic 时都会被调用
        let _stream_guard =
            StreamGuard::new(chat_v2_state_clone.clone(), session_id_for_cleanup.clone());

        // 调用真正的 Pipeline 执行
        let result = pipeline_clone
            .execute(
                window_clone,
                request_with_id,
                cancel_token,
                Some(chat_v2_state_clone.clone()),
            )
            .await;

        // remove_stream 由 _stream_guard 自动调用，无需手动清理

        match result {
            Ok(returned_msg_id) => {
                log::info!(
                    "[ChatV2::handlers] Pipeline completed: session_id={}, assistant_message_id={}",
                    session_id,
                    returned_msg_id
                );
            }
            Err(ChatV2Error::Cancelled) => {
                log::info!(
                    "[ChatV2::handlers] Pipeline cancelled: session_id={}",
                    session_id
                );
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::handlers] Pipeline error: session_id={}, error={}",
                    session_id,
                    e
                );
            }
        }
    });

    // 返回确定的 assistant_message_id（与 Pipeline 使用的 ID 一致）
    Ok(assistant_message_id)
}

/// 取消正在进行的流式生成
///
/// 触发取消信号，流水线会在各阶段检查并停止处理。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `message_id`: 消息 ID（用于发射取消事件）
/// - `window`: Tauri 窗口句柄
/// - `chat_v2_state`: Chat V2 专用状态
///
/// ## 返回
/// - `Ok(())`: 取消成功
/// - `Err(String)`: 没有活跃的流式生成
#[tauri::command]
pub async fn chat_v2_cancel_stream(
    session_id: String,
    message_id: String,
    window: Window,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_cancel_stream: session_id={}, message_id={}",
        session_id,
        message_id
    );

    if chat_v2_state.cancel_stream(&session_id) {
        // pipeline 的 Cancelled 分支会统一发射 stream_cancelled，此处不再重复发射
        log::info!(
            "[ChatV2::handlers] Stream cancellation requested: session={}, message={}",
            session_id,
            message_id
        );
        Ok(())
    } else {
        Err(ChatV2Error::Other("No active stream to cancel".to_string()).into())
    }
}

/// 重试消息生成
///
/// 使用相同的用户输入重新生成助手回复。
/// 🔧 语义修正：重试会**替换**原助手消息的内容，而不是创建新消息。
/// - 清除原助手消息的所有块
/// - 使用原消息 ID 重新生成内容
/// - 不增加消息列表条目
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `message_id`: 要重试的助手消息 ID
/// - `options`: 可选的覆盖选项（如更换模型）
/// - `window`: Tauri 窗口句柄，用于发射事件
/// - `db`: Chat V2 独立数据库
/// - `chat_v2_state`: Chat V2 专用状态
/// - `pipeline`: Chat V2 Pipeline
///
/// ## 返回
/// - `Ok(String)`: 返回原消息 ID（内容已被替换）
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn chat_v2_retry_message(
    session_id: String,
    message_id: String,
    options: Option<SendOptions>,
    window: Window,
    db: State<'_, Arc<ChatV2Database>>,
    // 🆕 VFS 统一存储：使用 vfs_db 恢复上下文引用
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    // ★ 2026-01-26：用于判断模型是否支持多模态
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<RetryMessageResult, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_retry_message: session_id={}, message_id={}",
        session_id,
        message_id
    );

    // 从数据库加载原消息
    let original_message = ChatV2Repo::get_message_v2(&db, &message_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.clone()).to_string())?;

    // 🔧 语义修正：重试只能针对助手消息
    // 如果是用户消息，应该使用"编辑并重发"功能
    if original_message.role == MessageRole::User {
        return Err(ChatV2Error::Validation(
            "Retry is only for assistant messages. Use edit_and_resend for user messages."
                .to_string(),
        )
        .into());
    }

    // 🔒 P0 修复：在任何破坏性操作之前原子注册流，消除 TOCTOU 竞态
    // 如果后续操作失败，需要在 error 路径中调用 remove_stream 清理
    let cancel_token = match chat_v2_state.try_register_stream(&session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Session has an active stream. Please wait for completion or cancel first."
                    .to_string(),
            )
            .into());
        }
    };

    // ★ 2025-12-10 统一改造：获取前一条用户消息的内容和上下文快照
    // 附件现在通过 context_snapshot.user_refs 恢复，不再使用 message.attachments
    let user_msg_result =
        find_preceding_user_message_with_attachments(&db, &session_id, &original_message).map_err(
            |e| {
                chat_v2_state.remove_stream(&session_id);
                e
            },
        )?;
    let user_content = user_msg_result.content;

    // ★ VFS 统一存储：从上下文快照恢复 SendContextRef（包含附件）
    // ★ 2026-01-26 修复：根据新模型的能力决定注入图片还是文本
    let model_id = options.as_ref().and_then(|o| o.model_id.as_deref());
    let is_multimodal = is_model_multimodal(&llm_manager, model_id).await;
    log::info!(
        "[ChatV2::handlers] Retry: model_id={:?}, is_multimodal={}",
        model_id,
        is_multimodal
    );

    let restored_context_refs = user_msg_result
        .context_snapshot
        .as_ref()
        .map(|snapshot| restore_context_refs_from_snapshot(&vfs_db, snapshot, is_multimodal));
    let restored_path_map = filter_path_map_for_send_refs(
        user_msg_result
            .context_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.path_map),
        restored_context_refs.as_deref(),
    );
    let has_context_refs = restored_context_refs
        .as_ref()
        .map_or(false, |refs| !refs.is_empty());
    if has_context_refs {
        log::info!(
            "[ChatV2::handlers] Retry with restored context refs: count={}",
            restored_context_refs.as_ref().unwrap().len()
        );
    }

    // 🔧 修复：删除助手消息之后的所有消息（含自身），确保前后端一致
    let messages_to_delete: Vec<String> = {
        let conn = db.get_conn_safe().map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;
        let all_messages =
            ChatV2Repo::get_session_messages_with_conn(&conn, &session_id).map_err(|e| {
                chat_v2_state.remove_stream(&session_id);
                e.to_string()
            })?;

        log::info!(
            "[ChatV2::handlers] Retry: found {} total messages in session",
            all_messages.len()
        );

        let target_index = all_messages
            .iter()
            .position(|m| m.id == message_id)
            .ok_or_else(|| {
                chat_v2_state.remove_stream(&session_id);
                ChatV2Error::MessageNotFound(message_id.clone()).to_string()
            })?;

        let to_delete: Vec<String> = all_messages
            .iter()
            .skip(target_index)
            .map(|m| m.id.clone())
            .collect();

        log::info!(
            "[ChatV2::handlers] Retry: target_index={}, total_messages={}, to_delete={}",
            target_index,
            all_messages.len(),
            to_delete.len()
        );

        to_delete
    };

    // 使用事务删除所有后续消息
    if !messages_to_delete.is_empty() {
        let conn = db.get_conn_safe().map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        // 🔧 P0 修复：先收集要 decrement 的 resource IDs（在事务外、decrement 前）
        // 事务 COMMIT 成功后再执行 decrement，避免事务回滚时引用计数已被减少
        let mut resource_ids_to_decrement: Vec<String> = Vec::new();
        for msg_id in &messages_to_delete {
            if let Ok(Some(msg)) = ChatV2Repo::get_message_with_conn(&conn, msg_id) {
                if let Some(ref meta) = msg.meta {
                    if let Some(ref context_snapshot) = meta.context_snapshot {
                        let resource_ids: Vec<&str> = context_snapshot.all_resource_ids();
                        for rid in resource_ids {
                            resource_ids_to_decrement.push(rid.to_string());
                        }
                    }
                }
            }
        }

        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!(
                "[ChatV2::handlers] Failed to begin transaction for retry: {}",
                e
            );
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        let mut deleted_count = 0;
        let mut delete_error: Option<String> = None;

        for msg_id in &messages_to_delete {
            // 删除消息（级联删除会自动删除关联的块）
            match ChatV2Repo::delete_message_with_conn(&conn, msg_id) {
                Ok(()) => {
                    deleted_count += 1;
                    log::debug!(
                        "[ChatV2::handlers] Deleted message for retry: msg_id={}",
                        msg_id
                    );
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::handlers] Failed to delete message {} for retry: {}",
                        msg_id,
                        e
                    );
                    delete_error = Some(format!("Failed to delete message {}: {}", msg_id, e));
                    break;
                }
            }
        }

        if delete_error.is_some() {
            let _ = conn.execute("ROLLBACK", []);
            chat_v2_state.remove_stream(&session_id);
            return Err(delete_error.unwrap());
        } else {
            conn.execute("COMMIT", []).map_err(|e| {
                log::error!(
                    "[ChatV2::handlers] Failed to commit transaction for retry: {}",
                    e
                );
                chat_v2_state.remove_stream(&session_id);
                e.to_string()
            })?;
        }

        log::info!(
            "[ChatV2::handlers] Deleted {} messages after user message for retry (transaction committed)",
            deleted_count
        );

        // 🔧 P0 修复：COMMIT 成功后再减少 VFS 引用计数
        // 即使 decrement 失败，消息已删除，最差结果是引用多 1（可由数据治理清理）
        if !resource_ids_to_decrement.is_empty() {
            if let Ok(vfs_conn) = vfs_db.get_conn_safe() {
                if let Err(e) =
                    VfsResourceRepo::decrement_refs_with_conn(&vfs_conn, &resource_ids_to_decrement)
                {
                    log::warn!(
                        "[ChatV2::handlers] Failed to decrement {} VFS refs after retry delete (non-fatal): {}",
                        resource_ids_to_decrement.len(), e
                    );
                } else {
                    log::debug!(
                        "[ChatV2::handlers] Decremented {} VFS refs after retry delete",
                        resource_ids_to_decrement.len()
                    );
                }
            } else {
                log::warn!(
                    "[ChatV2::handlers] Failed to get vfs_db connection for decrement refs (retry)"
                );
            }
        }
    }

    // 🔧 语义修正：使用原消息 ID，而不是生成新 ID
    let assistant_message_id = message_id.clone();

    // 克隆必要的数据用于异步任务
    let session_id_for_cleanup = session_id.clone();
    let window_clone = window.clone();
    let pipeline_clone = pipeline.inner().clone();
    let chat_v2_state_clone = chat_v2_state.inner().clone();
    let assistant_message_id_clone = assistant_message_id.clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    // 异步执行重试流水线
    chat_v2_state.spawn_tracked(async move {
        // 🔧 Panic guard: RAII 确保 remove_stream 在正常完成、取消或 panic 时都会被调用
        let _stream_guard = StreamGuard::new(chat_v2_state_clone.clone(), session_id_for_cleanup.clone());

        // ★ 2025-12-10 统一改造：移除 AttachmentInput 重建逻辑
        // 所有附件现在通过 restored_context_refs（从 context_snapshot 恢复）传递

        // 🔧 重试操作：
        // - skip_user_message_save = true：用户消息已存在，不需要创建
        // - skip_assistant_message_save = false：旧助手消息已删除，需要创建新消息（使用相同 ID）
        let merged_options = {
            let mut opts = options.unwrap_or_default();
            opts.skip_user_message_save = Some(true);
            // 🔧 修复：旧助手消息已被删除，需要创建新消息而非更新
            // skip_assistant_message_save 默认为 None/false，save_results 会调用 create_message_with_conn
            opts
        };

        let request = SendMessageRequest {
            session_id: session_id_for_cleanup.clone(),
            content: user_content,
            options: Some(merged_options),
            user_message_id: None,
            assistant_message_id: Some(assistant_message_id_clone),
            user_context_refs: restored_context_refs,
            path_map: restored_path_map,
            workspace_id: None,
        };

        // 调用真正的 Pipeline 执行
        // 🔧 P1修复：传递 chat_v2_state
        let result = pipeline_clone
            .execute(window_clone, request, cancel_token, Some(chat_v2_state_clone.clone()))
            .await;

        // remove_stream 由 _stream_guard 自动调用，无需手动清理

        match result {
            Ok(returned_msg_id) => {
                log::info!(
                    "[ChatV2::handlers] Retry pipeline completed: session_id={}, assistant_message_id={}",
                    session_id_for_cleanup,
                    returned_msg_id
                );
            }
            Err(ChatV2Error::Cancelled) => {
                log::info!(
                    "[ChatV2::handlers] Retry pipeline cancelled: session_id={}",
                    session_id_for_cleanup
                );
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::handlers] Retry pipeline error: session_id={}, error={}",
                    session_id_for_cleanup,
                    e
                );
            }
        }
    });

    // 🔧 语义修正：返回原消息 ID（内容被替换，而不是创建新消息）
    Ok(RetryMessageResult {
        message_id: assistant_message_id,
        deleted_message_ids: messages_to_delete,
        deleted_variant_ids: Vec::new(),
        new_variant_id: None,
    })
}

/// 编辑用户消息并重新发送
///
/// 更新原用户消息的内容，删除后续助手消息，然后重新生成助手回复。
///
/// ## 实现策略
/// 1. 更新原用户消息的内容块（数据库）
/// 2. 删除原消息之后的所有消息（数据库）
/// 3. 使用 `skip_user_message_save: true` 调用 Pipeline，避免创建冗余用户消息
/// 4. 保留原消息的附件，传递给 LLM 上下文
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `message_id`: 要编辑的用户消息 ID
/// - `new_content`: 新的消息内容
/// - `options`: 可选的覆盖选项
/// - `window`: Tauri 窗口句柄，用于发射事件
/// - `db`: Chat V2 独立数据库
/// - `chat_v2_state`: Chat V2 专用状态
/// - `pipeline`: Chat V2 Pipeline
///
/// ## 返回
/// - `Ok(EditAndResendResult)`: 新的 assistant_message_id 与删除列表
/// - `Err(String)`: 错误信息
#[tauri::command]
pub async fn chat_v2_edit_and_resend(
    session_id: String,
    message_id: String,
    new_content: String,
    // 🆕 P1-2: 支持传入新的上下文引用（如果为 None，则从原消息恢复）
    new_context_refs: Option<Vec<SendContextRef>>,
    // 🆕 path_map 覆盖（前端传新上下文时可附带）
    new_path_map: Option<std::collections::HashMap<String, String>>,
    options: Option<SendOptions>,
    window: Window,
    db: State<'_, Arc<ChatV2Database>>,
    // 🆕 VFS 统一存储：使用 vfs_db 恢复上下文引用
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    // ★ 2026-01-26：用于判断模型是否支持多模态
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<EditAndResendResult, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_edit_and_resend: session_id={}, message_id={}, new_content_len={}",
        session_id,
        message_id,
        new_content.len()
    );

    // 验证内容
    if new_content.trim().is_empty() {
        return Err(ChatV2Error::Validation("New content cannot be empty".to_string()).into());
    }

    // 验证原消息存在且是用户消息
    let original_message = ChatV2Repo::get_message_v2(&db, &message_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.clone()).to_string())?;

    if original_message.role != MessageRole::User {
        return Err(ChatV2Error::Validation("Can only edit user messages".to_string()).into());
    }

    // 🔒 P0 修复：任何写操作之前先校验消息归属，防止跨会话篡改
    if original_message.session_id != session_id {
        return Err(ChatV2Error::Validation(format!(
            "Message {} does not belong to session {}",
            message_id, session_id
        ))
        .into());
    }

    // 🔒 P0 修复：在任何破坏性操作之前原子注册流，消除 TOCTOU 竞态
    // 如果后续操作失败，需要在 error 路径中调用 remove_stream 清理
    let cancel_token = match chat_v2_state.try_register_stream(&session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Session has an active stream. Please wait for completion or cancel first."
                    .to_string(),
            )
            .into());
        }
    };

    let original_snapshot = original_message
        .meta
        .as_ref()
        .and_then(|meta| meta.context_snapshot.as_ref());

    // 🆕 P1-2: 三态语义
    // - None: 继承原消息上下文
    // - Some([]): 显式清空
    // - Some(non-empty): 使用新上下文
    let final_context_refs = match new_context_refs.as_ref() {
        Some(refs) => {
            if refs.is_empty() {
                log::info!("[ChatV2::handlers] Edit and resend with EXPLICIT empty context refs");
            } else {
                log::info!(
                    "[ChatV2::handlers] Edit and resend with NEW context refs: count={}",
                    refs.len()
                );
            }
            Some(refs.clone())
        }
        None => {
            // 🆕 VFS 统一存储：从原消息的 context_snapshot 恢复上下文引用
            // ★ 2026-01-26 修复：根据新模型的能力决定注入图片还是文本
            let model_id = options.as_ref().and_then(|o| o.model_id.as_deref());
            let is_multimodal = is_model_multimodal(&llm_manager, model_id).await;
            log::info!(
                "[ChatV2::handlers] Edit and resend: model_id={:?}, is_multimodal={}",
                model_id,
                is_multimodal
            );

            let restored_context_refs = original_snapshot.map(|snapshot| {
                restore_context_refs_from_snapshot(&vfs_db, snapshot, is_multimodal)
            });
            let has_context_refs = restored_context_refs
                .as_ref()
                .map_or(false, |refs| !refs.is_empty());
            if has_context_refs {
                log::info!(
                    "[ChatV2::handlers] Edit and resend with restored context refs: count={}",
                    restored_context_refs.as_ref().unwrap().len()
                );
            }
            restored_context_refs
        }
    };

    let final_path_map = match new_context_refs.as_ref() {
        Some(refs) => {
            if refs.is_empty() {
                None
            } else {
                let source_map = new_path_map
                    .as_ref()
                    .or_else(|| original_snapshot.map(|s| &s.path_map));
                filter_path_map_for_send_refs(source_map, Some(refs.as_slice()))
            }
        }
        None => filter_path_map_for_send_refs(
            original_snapshot.map(|snapshot| &snapshot.path_map),
            final_context_refs.as_deref(),
        ),
    };

    // ★ 2025-12-10 统一改造：移除 original_attachments 重建逻辑
    // 所有附件现在通过 final_context_refs（从 context_snapshot 恢复或前端传入）传递

    // 更新原用户消息的内容块
    {
        let conn = db.get_conn_safe().map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        // 获取原消息的块
        let blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &message_id).map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        // 找到 content 块并更新
        for block in blocks {
            if block.block_type == "content" {
                let mut updated_block = block.clone();
                updated_block.content = Some(new_content.clone());
                ChatV2Repo::update_block_with_conn(&conn, &updated_block).map_err(|e| {
                    chat_v2_state.remove_stream(&session_id);
                    e.to_string()
                })?;
                log::debug!(
                    "[ChatV2::handlers] Updated content block: block_id={}",
                    block.id
                );
                break;
            }
        }

        // 🆕 P1-2 修复：编辑重发时同步更新用户消息的 context_snapshot
        if let Some(refs) = final_context_refs.as_ref() {
            let user_refs: Vec<ContextRef> = refs
                .iter()
                .map(|r| ContextRef {
                    resource_id: r.resource_id.clone(),
                    hash: r.hash.clone(),
                    type_id: r.type_id.clone(),
                    display_name: r.display_name.clone(),
                    inject_modes: r.inject_modes.clone(),
                })
                .collect();

            let mut updated_message = original_message.clone();
            let mut meta = updated_message.meta.unwrap_or_default();
            if user_refs.is_empty() {
                meta.context_snapshot = None;
            } else {
                let mut snapshot = create_user_refs_snapshot(&user_refs).unwrap_or_default();
                if let Some(path_map) = final_path_map.as_ref() {
                    snapshot.path_map = path_map.clone();
                }
                meta.context_snapshot = Some(snapshot);
            }
            updated_message.meta = Some(meta);

            ChatV2Repo::update_message_with_conn(&conn, &updated_message).map_err(|e| {
                chat_v2_state.remove_stream(&session_id);
                e.to_string()
            })?;

            log::info!(
                "[ChatV2::handlers] Updated context_snapshot for edited user message: user_refs={}",
                user_refs.len()
            );
        }
    }

    // 🔧 P0 修复：使用 index-based 删除（与 retry_message 对齐），避免 timestamp 相同时误删前序消息
    let messages_to_delete: Vec<String> = {
        let conn = db.get_conn_safe().map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;
        let all_messages =
            ChatV2Repo::get_session_messages_with_conn(&conn, &session_id).map_err(|e| {
                chat_v2_state.remove_stream(&session_id);
                e.to_string()
            })?;

        // 按稳定排序（timestamp ASC, rowid ASC）定位用户消息的 index
        let target_index = all_messages
            .iter()
            .position(|m| m.id == message_id)
            .ok_or_else(|| {
                chat_v2_state.remove_stream(&session_id);
                ChatV2Error::MessageNotFound(message_id.clone()).to_string()
            })?;

        // 只删除该用户消息之后的所有消息（+1 保留用户消息本身）
        let to_delete: Vec<String> = all_messages
            .iter()
            .skip(target_index + 1)
            .map(|m| m.id.clone())
            .collect();

        log::info!(
            "[ChatV2::handlers] edit_and_resend: target_index={}, original_id={}, total_messages={}, to_delete={}",
            target_index, message_id, all_messages.len(), to_delete.len()
        );

        to_delete
    };

    // 🔧 修复：使用单次连接 + 事务删除后续消息，确保原子性
    // 注意：chat_v2_messages 表有 ON DELETE CASCADE，删除消息会自动删除关联的块
    if !messages_to_delete.is_empty() {
        let conn = db.get_conn_safe().map_err(|e| {
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        // 🔧 P0 修复：先收集要 decrement 的 resource IDs（在事务外、decrement 前）
        // 事务 COMMIT 成功后再执行 decrement，避免事务回滚时引用计数已被减少
        let mut resource_ids_to_decrement: Vec<String> = Vec::new();
        for msg_id in &messages_to_delete {
            if let Ok(Some(msg)) = ChatV2Repo::get_message_with_conn(&conn, msg_id) {
                if let Some(ref meta) = msg.meta {
                    if let Some(ref context_snapshot) = meta.context_snapshot {
                        let resource_ids: Vec<&str> = context_snapshot.all_resource_ids();
                        for rid in resource_ids {
                            resource_ids_to_decrement.push(rid.to_string());
                        }
                    }
                }
            }
        }

        // 使用事务确保原子性
        conn.execute("BEGIN IMMEDIATE", []).map_err(|e| {
            log::error!("[ChatV2::handlers] Failed to begin transaction: {}", e);
            chat_v2_state.remove_stream(&session_id);
            e.to_string()
        })?;

        let mut deleted_count = 0;
        let mut delete_error: Option<String> = None;

        for msg_id in &messages_to_delete {
            // 删除消息本身（级联删除会自动删除关联的块）
            match ChatV2Repo::delete_message_with_conn(&conn, msg_id) {
                Ok(()) => {
                    deleted_count += 1;
                    log::debug!(
                        "[ChatV2::handlers] Deleted subsequent message: msg_id={}",
                        msg_id
                    );
                }
                Err(e) => {
                    log::error!(
                        "[ChatV2::handlers] Failed to delete message {}: {}",
                        msg_id,
                        e
                    );
                    delete_error = Some(format!("Failed to delete message {}: {}", msg_id, e));
                    break;
                }
            }
        }

        // 提交或回滚事务
        if delete_error.is_some() {
            let _ = conn.execute("ROLLBACK", []);
            chat_v2_state.remove_stream(&session_id);
            return Err(delete_error.unwrap());
        } else {
            conn.execute("COMMIT", []).map_err(|e| {
                log::error!("[ChatV2::handlers] Failed to commit transaction: {}", e);
                chat_v2_state.remove_stream(&session_id);
                e.to_string()
            })?;
        }

        log::info!(
            "[ChatV2::handlers] Deleted {} subsequent messages after editing (transaction committed)",
            deleted_count
        );

        // 🔧 P0 修复：COMMIT 成功后再减少 VFS 引用计数
        // 即使 decrement 失败，消息已删除，最差结果是引用多 1（可由数据治理清理）
        if !resource_ids_to_decrement.is_empty() {
            if let Ok(vfs_conn) = vfs_db.get_conn_safe() {
                if let Err(e) =
                    VfsResourceRepo::decrement_refs_with_conn(&vfs_conn, &resource_ids_to_decrement)
                {
                    log::warn!(
                        "[ChatV2::handlers] Failed to decrement {} VFS refs after edit delete (non-fatal): {}",
                        resource_ids_to_decrement.len(), e
                    );
                } else {
                    log::debug!(
                        "[ChatV2::handlers] Decremented {} VFS refs after edit delete",
                        resource_ids_to_decrement.len()
                    );
                }
            } else {
                log::warn!(
                    "[ChatV2::handlers] Failed to get vfs_db connection for decrement refs (edit)"
                );
            }
        }
    }

    // 预先生成 assistant_message_id，确保返回值与 Pipeline 使用的 ID 一致
    let assistant_message_id = ChatMessage::generate_id();

    // 克隆必要的数据用于异步任务
    let session_id_for_cleanup = session_id.clone();
    let original_message_id = message_id.clone();
    let window_clone = window.clone();
    let pipeline_clone = pipeline.inner().clone();
    let chat_v2_state_clone = chat_v2_state.inner().clone();
    let assistant_message_id_clone = assistant_message_id.clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    // 异步执行编辑重发流水线
    chat_v2_state.spawn_tracked(async move {
        // 🔧 Panic guard: RAII 确保 remove_stream 在正常完成、取消或 panic 时都会被调用
        let _stream_guard = StreamGuard::new(chat_v2_state_clone.clone(), session_id_for_cleanup.clone());

        // 🔧 P0-1修复：构建 SendOptions，设置 skip_user_message_save = true
        // 这样 Pipeline 不会创建新的用户消息，避免冗余创建+删除
        let merged_options = {
            let mut opts = options.unwrap_or_default();
            opts.skip_user_message_save = Some(true);
            opts
        };

        // ★ 2025-12-10 统一改造：构建 SendMessageRequest
        let request = SendMessageRequest {
            session_id: session_id_for_cleanup.clone(),
            content: new_content,
            options: Some(merged_options),
            user_message_id: Some(original_message_id.clone()),
            assistant_message_id: Some(assistant_message_id_clone.clone()),
            user_context_refs: final_context_refs,
            path_map: final_path_map,
            workspace_id: None,
        };

        // 调用 Pipeline 执行
        // 🔧 P1修复：传递 chat_v2_state
        let result = pipeline_clone
            .execute(window_clone, request, cancel_token, Some(chat_v2_state_clone.clone()))
            .await;

        // remove_stream 由 _stream_guard 自动调用，无需手动清理

        match result {
            Ok(returned_msg_id) => {
                log::info!(
                    "[ChatV2::handlers] Edit and resend pipeline completed: session_id={}, assistant_message_id={}",
                    session_id_for_cleanup,
                    returned_msg_id
                );
                // 🔧 P0-1修复：无需再删除 Pipeline 创建的用户消息，因为 skip_user_message_save=true
            }
            Err(ChatV2Error::Cancelled) => {
                log::info!(
                    "[ChatV2::handlers] Edit and resend pipeline cancelled: session_id={}",
                    session_id_for_cleanup
                );
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::handlers] Edit and resend pipeline error: session_id={}, error={}",
                    session_id_for_cleanup,
                    e
                );
            }
        }
    });

    // 返回确定的 assistant_message_id（与 Pipeline 使用的 ID 一致）
    Ok(EditAndResendResult {
        new_message_id: assistant_message_id,
        deleted_message_ids: messages_to_delete,
        new_variant_id: None,
    })
}

// ============================================================================
// 内部辅助函数
// ============================================================================

/// 获取消息内容（从块中提取）
fn get_message_content(db: &ChatV2Database, message_id: &str) -> Result<String, String> {
    // 获取消息的所有块
    let blocks = ChatV2Repo::get_message_blocks_v2(db, message_id).map_err(|e| e.to_string())?;

    // 合并所有 content 类型块的内容
    let content: String = blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("");

    if content.is_empty() {
        // 如果没有 content 块，返回错误
        return Err(ChatV2Error::Other("Message has no content blocks".to_string()).into());
    }

    Ok(content)
}

/// 查找前一条用户消息的内容
fn find_preceding_user_message_content(
    db: &ChatV2Database,
    session_id: &str,
    assistant_message: &ChatMessage,
) -> Result<String, String> {
    // 获取会话的所有消息
    let messages =
        ChatV2Repo::get_session_messages_v2(db, session_id).map_err(|e| e.to_string())?;

    // 按时间戳排序，找到助手消息之前的最近一条用户消息
    let assistant_timestamp = &assistant_message.timestamp;

    // 找到时间戳在助手消息之前的最后一条用户消息
    let user_message = messages
        .iter()
        .filter(|m| m.role == MessageRole::User && m.timestamp <= *assistant_timestamp)
        .last();

    match user_message {
        Some(msg) => get_message_content(db, &msg.id),
        None => Err(ChatV2Error::Other("No preceding user message found".to_string()).into()),
    }
}

/// 用户消息恢复结果（统一用户消息处理）
///
/// 用于重试/编辑重发时恢复原用户消息的完整数据
struct UserMessageRestoreResult {
    /// 用户消息文本内容
    content: String,
    /// 用户消息附件
    attachments: Option<Vec<AttachmentMeta>>,
    /// 上下文快照（用于恢复上下文引用）
    context_snapshot: Option<ContextSnapshot>,
    /// 用户消息时间戳（用于删除后续消息）
    timestamp: i64,
}

fn filter_path_map_for_send_refs(
    path_map: Option<&std::collections::HashMap<String, String>>,
    refs: Option<&[SendContextRef]>,
) -> Option<std::collections::HashMap<String, String>> {
    let path_map = path_map?;
    let refs = refs?;
    if path_map.is_empty() {
        return None;
    }
    if refs.is_empty() {
        return None;
    }

    let mut filtered = path_map.clone();
    let keep: std::collections::HashSet<&str> =
        refs.iter().map(|r| r.resource_id.as_str()).collect();
    filtered.retain(|resource_id, _| keep.contains(resource_id.as_str()));

    if filtered.is_empty() {
        None
    } else {
        Some(filtered)
    }
}

/// 查找前一条用户消息的内容、附件和上下文快照
///
/// 🆕 统一用户消息处理：同时返回 context_snapshot，确保重试时上下文引用不丢失
fn find_preceding_user_message_with_attachments(
    db: &ChatV2Database,
    session_id: &str,
    assistant_message: &ChatMessage,
) -> Result<UserMessageRestoreResult, String> {
    // 获取会话的所有消息
    let messages =
        ChatV2Repo::get_session_messages_v2(db, session_id).map_err(|e| e.to_string())?;

    // 按时间戳排序，找到助手消息之前的最近一条用户消息
    let assistant_timestamp = &assistant_message.timestamp;

    // 找到时间戳在助手消息之前的最后一条用户消息
    let user_message = messages
        .iter()
        .filter(|m| m.role == MessageRole::User && m.timestamp <= *assistant_timestamp)
        .last();

    match user_message {
        Some(msg) => {
            let content = get_message_content(db, &msg.id)?;
            let attachments = msg.attachments.clone();
            // 🆕 统一用户消息处理：提取 context_snapshot
            let context_snapshot = msg
                .meta
                .as_ref()
                .and_then(|meta| meta.context_snapshot.clone());
            let timestamp = msg.timestamp;
            Ok(UserMessageRestoreResult {
                content,
                attachments,
                context_snapshot,
                timestamp,
            })
        }
        None => Err(ChatV2Error::Other("No preceding user message found".to_string()).into()),
    }
}

/// 从上下文快照恢复 SendContextRef 列表
///
/// 🆕 VFS 统一存储：从 ContextSnapshot 中的 user_refs 恢复 SendContextRef，
/// 通过 VfsResourceRepo 获取资源内容并转换为 ContentBlock。
///
/// ★ 修复（2025-12-09）：正确解析 VfsContextRefData 获取实际内容
/// ★ 修复（2026-01-26）：添加 is_multimodal 参数，根据模型能力决定注入图片还是文本
fn restore_context_refs_from_snapshot(
    vfs_db: &VfsDatabase,
    context_snapshot: &ContextSnapshot,
    is_multimodal: bool,
) -> Vec<SendContextRef> {
    let mut result = Vec::new();

    // ★ 修复（2025-12-10）：在循环外获取一次连接，避免死锁风险
    let conn = match vfs_db.get_conn_safe() {
        Ok(c) => c,
        Err(e) => {
            log::warn!(
                "[ChatV2::handlers] Failed to get vfs.db connection for restore: {}",
                e
            );
            return result;
        }
    };

    // 只恢复 user_refs（用户添加的上下文引用）
    // retrieval_refs 是由 RAG 检索产生的，重试时会重新检索
    for context_ref in &context_snapshot.user_refs {
        // 优先使用 hash 精确匹配，失败时回退到按 ID 获取
        let resource = VfsResourceRepo::get_by_hash_with_conn(&conn, &context_ref.hash)
            .ok()
            .flatten()
            .or_else(|| {
                VfsResourceRepo::get_resource_with_conn(&conn, &context_ref.resource_id)
                    .ok()
                    .flatten()
            });

        if let Some(res) = resource {
            let data_str = res.data.unwrap_or_default();

            // ★ 尝试解析为 VfsContextRefData（引用模式）
            // ★ 2025-12-10：使用统一的 vfs_resolver 模块
            use crate::chat_v2::vfs_resolver::resolve_context_ref_data_to_blocks;

            let formatted_blocks = if let Ok(mut ref_data) =
                serde_json::from_str::<VfsContextRefData>(&data_str)
            {
                // ★ 2026-02 修复：从 ContextRef 恢复用户选择的 inject_modes
                // 这是解决重试时图片变文本问题的关键修复
                if let Some(ref saved_inject_modes) = context_ref.inject_modes {
                    log::info!(
                        "[ChatV2::handlers] Restoring inject_modes from snapshot: {:?}",
                        saved_inject_modes
                    );
                    // 更新 ref_data 中每个引用的 inject_modes
                    for vfs_ref in &mut ref_data.refs {
                        vfs_ref.inject_modes = Some(saved_inject_modes.clone());
                    }
                }

                // 引用模式：使用统一解引用模块获取内容块
                // ★ 2026-01-26 修复：根据模型能力决定注入图片还是文本
                let blocks = resolve_context_ref_data_to_blocks(
                    &conn,
                    vfs_db.blobs_dir(),
                    &ref_data,
                    is_multimodal,
                );
                if blocks.is_empty() {
                    // 如果所有引用都无法解析，返回占位文本
                    vec![ContentBlock::Text {
                        text: format!("[资源已删除: {}]", context_ref.resource_id),
                    }]
                } else {
                    blocks
                }
            } else {
                // 非引用模式（旧数据或直接内容）：为避免误注入，返回提示并记录告警
                log::warn!(
                    "[ChatV2::handlers] Context snapshot data is not VfsContextRefData, ignored: resource_id={}, data_len={}",
                    context_ref.resource_id,
                    data_str.len()
                );
                let display_name = context_ref
                    .display_name
                    .as_ref()
                    .cloned()
                    .unwrap_or_else(|| context_ref.resource_id.clone());
                vec![ContentBlock::Text {
                    text: format!("[旧版上下文引用已忽略: {}]", display_name),
                }]
            };

            // ★ 2026-02 修复：在 SendContextRef 中保留 inject_modes
            result.push(SendContextRef {
                resource_id: context_ref.resource_id.clone(),
                hash: context_ref.hash.clone(),
                type_id: context_ref.type_id.clone(),
                formatted_blocks,
                display_name: context_ref.display_name.clone(),
                inject_modes: context_ref.inject_modes.clone(),
            });

            log::debug!(
                "[ChatV2::handlers] Restored context ref: resource_id={}, type_id={}, inject_modes={:?}",
                context_ref.resource_id,
                context_ref.type_id,
                context_ref.inject_modes
            );
        } else {
            log::warn!(
                "[ChatV2::handlers] Failed to restore context ref (resource not found): resource_id={}",
                context_ref.resource_id
            );
        }
    }

    log::info!(
        "[ChatV2::handlers] Restored {} context refs from snapshot (user_refs={})",
        result.len(),
        context_snapshot.user_refs.len()
    );

    result
}

/// 🆕 继续执行中断的消息
///
/// 当消息因网络错误、LLM 超时等原因中断，但有未完成的 TODO 列表时，
/// 可以调用此命令在**同一条消息内**继续执行，而不是新开一轮消息。
///
/// ## 使用场景
/// 1. LLM 调用因网络超时失败，但 TODO 列表未完成
/// 2. 用户取消后想继续执行
/// 3. 达到工具递归限制后想继续
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `message_id`: 要继续的助手消息 ID
/// - `variant_id`: 要继续的变体 ID（可选，默认使用活跃变体）
/// - `options`: 覆盖选项（可选）
///
/// ## 返回
/// - `Ok(String)`: 返回消息 ID
/// - `Err(String)`: 错误信息（如没有未完成的 TODO 列表）
///
/// ## 前提条件
/// - 变体状态必须是 `interrupted`（可继续）
/// - 必须有持久化的未完成 TODO 列表
#[tauri::command]
pub async fn chat_v2_continue_message(
    session_id: String,
    message_id: String,
    variant_id: Option<String>,
    options: Option<SendOptions>,
    window: Window,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    // ★ 2026-01-26：用于判断模型是否支持多模态
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<String, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_continue_message: session_id={}, message_id={}, variant_id={:?}",
        session_id,
        message_id,
        variant_id
    );

    // 加载持久化的 TodoList (活跃流检查由 try_register_stream 原子完成)
    let todo_info = load_persisted_todo_list(&db, &session_id)
        .map_err(|e| format!("Failed to load TodoList: {}", e))?;

    let (todo_list, persisted_message_id, persisted_variant_id) = match todo_info {
        Some(info) => info,
        None => {
            return Err(ChatV2Error::Validation(
                "No incomplete TODO list found. Cannot continue execution.".to_string(),
            )
            .into());
        }
    };

    // 3. 验证消息 ID 匹配
    if persisted_message_id != message_id {
        log::warn!(
            "[ChatV2::handlers] Message ID mismatch: expected={}, got={}",
            persisted_message_id,
            message_id
        );
        // 仍然使用持久化的 message_id，因为它是正确的
    }

    // 4. 验证 TODO 列表未完成
    if todo_list.is_all_done() {
        return Err(ChatV2Error::Validation(
            "TODO list is already complete. No need to continue.".to_string(),
        )
        .into());
    }

    log::info!(
        "[ChatV2::handlers] Found incomplete TODO list: id={}, title={}, progress={}/{}",
        todo_list.id,
        todo_list.title,
        todo_list.completed_count(),
        todo_list.total_count()
    );

    // 5. 恢复 TodoList 到内存
    restore_todo_list_from_db(&db, &session_id)
        .map_err(|e| format!("Failed to restore TodoList: {}", e))?;

    // 6. 加载原消息
    let original_message = ChatV2Repo::get_message_v2(&db, &persisted_message_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::MessageNotFound(persisted_message_id.clone()).to_string())?;

    // 7. 验证变体状态（必须是 interrupted 才能继续）
    let target_variant_id = variant_id
        .or(persisted_variant_id)
        .or_else(|| original_message.active_variant_id.clone());

    if let Some(ref var_id) = target_variant_id {
        if let Some(ref variants) = original_message.variants {
            if let Some(variant) = variants.iter().find(|v| &v.id == var_id) {
                if variant.status != variant_status::INTERRUPTED {
                    log::warn!(
                        "[ChatV2::handlers] Variant status is '{}', not 'interrupted'. Allowing continue anyway.",
                        variant.status
                    );
                    // 允许从其他状态继续（如 error），但记录警告
                }
            }
        }
    }

    // 8. 获取前一条用户消息的内容
    let user_msg_result =
        find_preceding_user_message_with_attachments(&db, &session_id, &original_message)?;
    let user_content = user_msg_result.content;

    // 恢复上下文引用
    // ★ 2026-01-26 修复：根据模型能力决定注入图片还是文本
    let model_id = options.as_ref().and_then(|o| o.model_id.as_deref());
    let is_multimodal = is_model_multimodal(&llm_manager, model_id).await;
    log::info!(
        "[ChatV2::handlers] Continue: model_id={:?}, is_multimodal={}",
        model_id,
        is_multimodal
    );

    let restored_context_refs = user_msg_result
        .context_snapshot
        .as_ref()
        .map(|snapshot| restore_context_refs_from_snapshot(&vfs_db, snapshot, is_multimodal));
    let restored_path_map = filter_path_map_for_send_refs(
        user_msg_result
            .context_snapshot
            .as_ref()
            .map(|snapshot| &snapshot.path_map),
        restored_context_refs.as_deref(),
    );

    // 9. 构建继续执行的请求
    // 关键：使用原消息 ID 和变体 ID，这样 Pipeline 会继续在同一消息内执行
    let continue_request = SendMessageRequest {
        session_id: session_id.clone(),
        content: user_content,
        assistant_message_id: Some(persisted_message_id.clone()),
        user_context_refs: restored_context_refs,
        options: options.map(|mut opts| {
            opts.is_continue = Some(true);
            opts.continue_variant_id = target_variant_id.clone();
            opts
        }),
        user_message_id: None,
        path_map: restored_path_map,
        workspace_id: None,
    };

    // 10. 注册流并执行
    let cancel_token = match chat_v2_state.try_register_stream(&session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Failed to register stream for continue execution.".to_string(),
            )
            .into());
        }
    };

    let session_id_for_cleanup = session_id.clone();
    let window_clone = window.clone();
    let pipeline_clone = pipeline.inner().clone();
    let chat_v2_state_clone = chat_v2_state.inner().clone();
    let result_message_id = persisted_message_id.clone();

    // 🆕 P1修复：使用 TaskTracker 追踪异步任务
    // 11. 异步执行 Pipeline（继续模式）
    chat_v2_state.spawn_tracked(async move {
        // 🔧 Panic guard: RAII 确保 remove_stream 在正常完成、取消或 panic 时都会被调用
        let _stream_guard =
            StreamGuard::new(chat_v2_state_clone.clone(), session_id_for_cleanup.clone());

        let result = pipeline_clone
            .execute(
                window_clone,
                continue_request,
                cancel_token,
                Some(chat_v2_state_clone.clone()),
            )
            .await;

        log::debug!(
            "[ChatV2::handlers] Continue stream cleanup completed for session: {}",
            session_id_for_cleanup
        );

        match result {
            Ok(returned_msg_id) => {
                log::info!(
                    "[ChatV2::handlers] Continue execution completed: session_id={}, message_id={}",
                    session_id_for_cleanup,
                    returned_msg_id
                );
            }
            Err(ChatV2Error::Cancelled) => {
                log::info!(
                    "[ChatV2::handlers] Continue execution cancelled: session_id={}",
                    session_id_for_cleanup
                );
            }
            Err(e) => {
                log::error!(
                    "[ChatV2::handlers] Continue execution error: session_id={}, error={}",
                    session_id_for_cleanup,
                    e
                );
            }
        }
    });

    Ok(result_message_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::MessageBlock;
    use std::collections::HashMap;

    #[test]
    fn test_message_id_generation() {
        let id1 = ChatMessage::generate_id();
        let id2 = ChatMessage::generate_id();

        assert!(id1.starts_with("msg_"));
        assert!(id2.starts_with("msg_"));
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_block_id_generation() {
        let id1 = MessageBlock::generate_id();
        let id2 = MessageBlock::generate_id();

        assert!(id1.starts_with("blk_"));
        assert!(id2.starts_with("blk_"));
        assert_ne!(id1, id2);
    }

    fn make_send_ref(resource_id: &str) -> SendContextRef {
        SendContextRef {
            resource_id: resource_id.to_string(),
            hash: format!("hash_{}", resource_id),
            type_id: "file".to_string(),
            formatted_blocks: vec![ContentBlock::text("test")],
            display_name: None,
            inject_modes: None,
        }
    }

    #[test]
    fn test_filter_path_map_for_send_refs_returns_none_when_path_map_missing() {
        let refs = vec![make_send_ref("res_1")];
        let filtered = filter_path_map_for_send_refs(None, Some(refs.as_slice()));
        assert!(filtered.is_none());
    }

    #[test]
    fn test_filter_path_map_for_send_refs_returns_none_when_refs_missing_or_empty() {
        let mut path_map = HashMap::new();
        path_map.insert("res_1".to_string(), "/tmp/a.pdf".to_string());

        let filtered_none_refs = filter_path_map_for_send_refs(Some(&path_map), None);
        assert!(filtered_none_refs.is_none());

        let empty_refs: Vec<SendContextRef> = Vec::new();
        let filtered_empty_refs =
            filter_path_map_for_send_refs(Some(&path_map), Some(empty_refs.as_slice()));
        assert!(filtered_empty_refs.is_none());
    }

    #[test]
    fn test_filter_path_map_for_send_refs_keeps_only_matched_resource_ids() {
        let mut path_map = HashMap::new();
        path_map.insert("res_1".to_string(), "/tmp/a.pdf".to_string());
        path_map.insert("res_2".to_string(), "/tmp/b.pdf".to_string());
        path_map.insert("res_3".to_string(), "/tmp/c.pdf".to_string());

        let refs = vec![make_send_ref("res_1"), make_send_ref("res_3")];
        let filtered =
            filter_path_map_for_send_refs(Some(&path_map), Some(refs.as_slice())).unwrap();

        assert_eq!(filtered.len(), 2);
        assert_eq!(
            filtered.get("res_1").map(String::as_str),
            Some("/tmp/a.pdf")
        );
        assert_eq!(
            filtered.get("res_3").map(String::as_str),
            Some("/tmp/c.pdf")
        );
        assert!(!filtered.contains_key("res_2"));
    }

    #[test]
    fn test_filter_path_map_for_send_refs_returns_none_when_no_match() {
        let mut path_map = HashMap::new();
        path_map.insert("res_1".to_string(), "/tmp/a.pdf".to_string());

        let refs = vec![make_send_ref("res_2")];
        let filtered = filter_path_map_for_send_refs(Some(&path_map), Some(refs.as_slice()));
        assert!(filtered.is_none());
    }
}
