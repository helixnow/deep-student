//! 变体管理 Tauri 命令处理器
//!
//! 提供多模型并行变体的管理功能，包括：
//! - 切换激活变体
//! - 删除变体
//! - 重试变体
//! - 取消变体生成
//!
//! ## 约束条件
//! 1. `switch_variant`: 验证目标变体状态不是 `error`
//! 2. `delete_variant`: 不能删除最后一个变体
//! 3. `retry_variant`: 只能重试 `error/cancelled` 状态
//! 4. 删除后发射 `variant_deleted` 事件

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;
use tauri::{Emitter, State, Window};
use tracing::{debug, info, warn};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::{ChatV2Error, ChatV2Result};
use crate::chat_v2::events::session_event_type;
use crate::chat_v2::pipeline::{ChatV2Pipeline, VariantRetrySpec};
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::types::{
    variant_status, AttachmentInput, ChatMessage, MessageRole, SendOptions, SharedContext,
};
use crate::chat_v2::vfs_resolver::{resolve_context_ref_data_to_content, ResolvedContent};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsResourceRepo;
use crate::vfs::types::VfsContextRefData;

// ============================================================================
// 响应类型
// ============================================================================

/// 删除变体响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteVariantResult {
    /// 被删除的变体 ID
    pub deleted_variant_id: String,
    /// 删除后剩余的变体数量
    pub remaining_count: usize,
    /// 新的激活变体 ID（如果删除的是当前激活的变体）
    pub new_active_variant_id: Option<String>,
}

fn resolve_retry_options(
    saved_chat_params: Option<&serde_json::Value>,
    model_id: &str,
    options_override: Option<SendOptions>,
) -> SendOptions {
    if let Some(mut options) = options_override {
        options.model_id = Some(model_id.to_string());
        options.model2_override_id = Some(model_id.to_string());
        options.parallel_model_ids = None;
        return options;
    }

    let mut options = SendOptions {
        model_id: Some(model_id.to_string()),
        model2_override_id: Some(model_id.to_string()),
        ..Default::default()
    };

    if let Some(params) = saved_chat_params {
        options.temperature = params
            .get("temperature")
            .and_then(|v| v.as_f64())
            .map(|v| v as f32);
        options.max_tokens = params
            .get("maxTokens")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32);
        options.enable_thinking = params.get("enableThinking").and_then(|v| v.as_bool());
    }

    options
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 切换激活变体
///
/// 将指定变体设为当前激活状态。
///
/// ## 约束
/// - 目标变体状态不能是 `error`
///
/// ## 参数
/// - `message_id`: 消息 ID
/// - `variant_id`: 目标变体 ID
#[tauri::command]
pub async fn chat_v2_switch_variant(
    db: State<'_, Arc<ChatV2Database>>,
    message_id: String,
    variant_id: String,
) -> Result<(), String> {
    info!(
        "[ChatV2::VariantHandler] switch_variant: message_id={}, variant_id={}",
        message_id, variant_id
    );

    switch_variant_impl(&db, &message_id, &variant_id)
        .await
        .map_err(|e| e.to_string())
}

async fn switch_variant_impl(
    db: &ChatV2Database,
    message_id: &str,
    variant_id: &str,
) -> ChatV2Result<()> {
    let conn = db.get_conn_safe()?;

    // 1. 获取消息
    let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

    // 2. 获取目标变体
    let variant = message
        .get_variant(variant_id)
        .ok_or_else(|| ChatV2Error::VariantNotFound(variant_id.to_string()))?;

    // 3. 验证变体状态不是 error
    if !variant.can_activate() {
        return Err(ChatV2Error::VariantCannotActivateFailed(
            variant_id.to_string(),
        ));
    }

    // 4. 更新激活变体
    message.active_variant_id = Some(variant_id.to_string());

    // 5. 持久化
    ChatV2Repo::update_message_with_conn(&conn, &message)?;

    info!(
        "[ChatV2::VariantHandler] Variant switched: message_id={}, variant_id={}",
        message_id, variant_id
    );

    Ok(())
}

/// 删除变体
///
/// 删除指定变体及其关联的所有块。
///
/// ## 约束
/// - 不能删除最后一个变体
/// - 如果删除的是当前激活的变体，自动切换到另一个可用变体
///
/// ## 参数
/// - `message_id`: 消息 ID
/// - `variant_id`: 要删除的变体 ID
#[tauri::command]
pub async fn chat_v2_delete_variant(
    db: State<'_, Arc<ChatV2Database>>,
    window: Window,
    message_id: String,
    variant_id: String,
) -> Result<DeleteVariantResult, String> {
    info!(
        "[ChatV2::VariantHandler] delete_variant: message_id={}, variant_id={}",
        message_id, variant_id
    );

    delete_variant_impl(&db, &window, &message_id, &variant_id)
        .await
        .map_err(|e| e.to_string())
}

async fn delete_variant_impl(
    db: &ChatV2Database,
    window: &Window,
    message_id: &str,
    variant_id: &str,
) -> ChatV2Result<DeleteVariantResult> {
    let conn = db.get_conn_safe()?;

    // 1. 获取消息
    let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

    // 2. 获取变体列表
    let variants = message
        .variants
        .as_ref()
        .ok_or_else(|| ChatV2Error::VariantNotFound(variant_id.to_string()))?;

    // 3. 检查是否是最后一个变体
    if variants.len() <= 1 {
        return Err(ChatV2Error::VariantCannotDeleteLast);
    }

    // 4. 查找要删除的变体及其索引
    let variant_index = variants
        .iter()
        .position(|v| v.id == variant_id)
        .ok_or_else(|| ChatV2Error::VariantNotFound(variant_id.to_string()))?;

    let variant_to_delete = &variants[variant_index];

    // 🔒 P0 修复（2026-01-10）：检查变体是否正在流式生成
    // 防止删除正在流式的变体导致 Pipeline 写入已删除块失败
    if variant_to_delete.status == variant_status::STREAMING {
        return Err(ChatV2Error::Other(
            "Cannot delete a streaming variant. Please wait for completion or cancel it first."
                .to_string(),
        )
        .into());
    }

    let block_ids_to_delete = variant_to_delete.block_ids.clone();

    // 5. 删除变体的所有块
    for block_id in &block_ids_to_delete {
        if let Err(e) = ChatV2Repo::delete_block_with_conn(&conn, block_id) {
            warn!(
                "[ChatV2::VariantHandler] Failed to delete block {}: {}",
                block_id, e
            );
        }
    }

    // 6. 从变体列表中移除
    let mut new_variants = variants.clone();
    new_variants.remove(variant_index);

    // 7. 如果删除的是当前激活的变体，切换到另一个
    let mut new_active_variant_id = None;
    if message.active_variant_id.as_deref() == Some(variant_id) {
        // 优先选择 success > pending > streaming > cancelled 的变体
        let priority_order = [
            variant_status::SUCCESS,
            variant_status::PENDING,
            variant_status::STREAMING,
            variant_status::CANCELLED,
        ];

        for status in priority_order {
            if let Some(v) = new_variants.iter().find(|v| v.status == status) {
                new_active_variant_id = Some(v.id.clone());
                break;
            }
        }

        // 如果没有找到符合优先级的，选择第一个非 error 的
        if new_active_variant_id.is_none() {
            if let Some(v) = new_variants.iter().find(|v| v.can_activate()) {
                new_active_variant_id = Some(v.id.clone());
            }
        }

        // 如果还是没有，就选择第一个（即使是 error）
        if new_active_variant_id.is_none() {
            new_active_variant_id = new_variants.first().map(|v| v.id.clone());
        }

        message.active_variant_id = new_active_variant_id.clone();
    }

    let remaining_count = new_variants.len();
    message.variants = Some(new_variants);

    // 8. 更新消息的 block_ids（移除已删除变体的块）
    message
        .block_ids
        .retain(|id| !block_ids_to_delete.contains(id));

    // 9. 持久化
    ChatV2Repo::update_message_with_conn(&conn, &message)?;

    // 10. 发射 variant_deleted 事件
    let session_id = &message.session_id;
    let event_name = format!("chat_v2_session_{}", session_id);
    let payload = serde_json::json!({
        "eventType": session_event_type::VARIANT_DELETED,
        "messageId": message_id,
        "variantId": variant_id,
        "remainingCount": remaining_count,
        "newActiveVariantId": new_active_variant_id,
    });

    if let Err(e) = window.emit(&event_name, &payload) {
        warn!(
            "[ChatV2::VariantHandler] Failed to emit variant_deleted event: {}",
            e
        );
    }

    info!(
        "[ChatV2::VariantHandler] Variant deleted: message_id={}, variant_id={}, remaining={}",
        message_id, variant_id, remaining_count
    );

    Ok(DeleteVariantResult {
        deleted_variant_id: variant_id.to_string(),
        remaining_count,
        new_active_variant_id,
    })
}

/// 重试变体
///
/// 重新执行指定变体的 LLM 调用。
///
/// ## 约束
/// - 只能重试 `error` 或 `cancelled` 状态的变体
/// - 重置变体状态为 `pending`，清空旧 blocks
/// - 触发 Pipeline 重新执行，复用 `SharedContext`
///
/// ## 参数
/// - `message_id`: 消息 ID
/// - `variant_id`: 要重试的变体 ID
/// - `model_override`: 可选的模型覆盖（用于切换模型重试）
#[tauri::command]
pub async fn chat_v2_retry_variant(
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    window: Window,
    message_id: String,
    variant_id: String,
    model_override: Option<String>,
    options: Option<SendOptions>,
) -> Result<(), String> {
    info!(
        "[ChatV2::VariantHandler] retry_variant: message_id={}, variant_id={}, model_override={:?}",
        message_id, variant_id, model_override
    );

    retry_variant_impl(
        &db,
        &vfs_db,
        &chat_v2_state,
        &pipeline,
        window,
        &message_id,
        &variant_id,
        model_override,
        options,
    )
    .await
    .map_err(|e| e.to_string())
}

/// 批量重试变体
///
/// 重新执行指定变体的 LLM 调用（允许 success 变体重试）。
///
/// ## 参数
/// - `message_id`: 消息 ID
/// - `variant_ids`: 要重试的变体 ID 列表
#[tauri::command]
pub async fn chat_v2_retry_variants(
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
    pipeline: State<'_, Arc<ChatV2Pipeline>>,
    window: Window,
    message_id: String,
    variant_ids: Vec<String>,
    options: Option<SendOptions>,
) -> Result<(), String> {
    info!(
        "[ChatV2::VariantHandler] retry_variants: message_id={}, variant_count={}",
        message_id,
        variant_ids.len()
    );

    retry_variants_impl(
        &db,
        &vfs_db,
        &chat_v2_state,
        &pipeline,
        window,
        &message_id,
        &variant_ids,
        options,
    )
    .await
    .map_err(|e| e.to_string())
}

async fn retry_variant_impl(
    db: &ChatV2Database,
    vfs_db: &VfsDatabase,
    chat_v2_state: &ChatV2State,
    pipeline: &ChatV2Pipeline,
    window: Window,
    message_id: &str,
    variant_id: &str,
    model_override: Option<String>,
    options_override: Option<SendOptions>,
) -> ChatV2Result<()> {
    let conn = db.get_conn_safe()?;

    // 1. 获取助手消息
    let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

    // 2. 验证是助手消息
    if message.role != MessageRole::Assistant {
        return Err(ChatV2Error::Validation(
            "Can only retry variants on assistant messages".to_string(),
        ));
    }

    // 🔒 P1 修复（2026-01-10）：检查会话是否有活跃流
    // 防止会话流式中触发变体重试，避免多个 cancel token 交织
    let session_id = message.session_id.clone();
    if chat_v2_state.has_active_stream(&session_id) {
        return Err(ChatV2Error::Other(
            "Cannot retry variant while session is streaming. Please wait for completion or cancel first.".to_string()
        ).into());
    }

    // 3. 获取变体
    let variant = message
        .get_variant_mut(variant_id)
        .ok_or_else(|| ChatV2Error::VariantNotFound(variant_id.to_string()))?;

    // 4. 检查是否正在 streaming（优先于 can_retry 检查）
    if variant.status == variant_status::STREAMING {
        return Err(ChatV2Error::VariantAlreadyStreaming(variant_id.to_string()));
    }

    // 5. 验证变体可以重试（error 或 cancelled 状态）
    if !variant.can_retry() {
        return Err(ChatV2Error::VariantCannotRetry(
            variant_id.to_string(),
            variant.status.clone(),
        ));
    }

    // 6. 🔧 P2修复：获取模型配置 ID（优先使用 override，其次使用 config_id，最后回退到 model_id）
    // config_id 是 API 配置 ID，用于 LLM 调用；model_id 是显示名
    let model_id = model_override.unwrap_or_else(|| {
        variant
            .config_id
            .clone()
            .unwrap_or_else(|| variant.model_id.clone())
    });

    // 7. 删除变体的旧块
    let old_block_ids = variant.block_ids.clone();
    for block_id in &old_block_ids {
        if let Err(e) = ChatV2Repo::delete_block_with_conn(&conn, block_id) {
            warn!(
                "[ChatV2::VariantHandler] Failed to delete old block {}: {}",
                block_id, e
            );
        }
    }

    // 8. 重置变体状态
    variant.block_ids.clear();
    variant.status = variant_status::PENDING.to_string();
    variant.error = None;
    variant.model_id = model_id.clone();

    // 9. 更新消息的 block_ids（移除已删除的块）
    message.block_ids.retain(|id| !old_block_ids.contains(id));

    // 10. 持久化变体重置
    ChatV2Repo::update_message_with_conn(&conn, &message)?;

    // 11. 获取原始用户消息（查找助手消息之前的用户消息）
    let session_messages = ChatV2Repo::get_session_messages_with_conn(&conn, &session_id)?;

    // 查找当前助手消息在消息列表中的位置，然后找到前一条用户消息
    let user_message = session_messages
        .iter()
        .rev()
        .skip_while(|m| m.id != message_id)
        .skip(1) // 跳过当前助手消息
        .find(|m| m.role == MessageRole::User)
        .ok_or_else(|| {
            ChatV2Error::Validation("Cannot find original user message for retry".to_string())
        })?;

    // 12. 获取用户消息内容
    let user_blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &user_message.id)?;
    let user_content = user_blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("");

    if user_content.is_empty() {
        return Err(ChatV2Error::Validation(
            "Original user message has no content".to_string(),
        ));
    }

    // 13. 转换用户附件为 AttachmentInput
    let base_user_attachments: Vec<AttachmentInput> = user_message
        .attachments
        .as_ref()
        .map(|attachments| {
            attachments
                .iter()
                .filter_map(|a| {
                    // 从 preview_url 提取 base64 内容
                    let (base64_content, text_content) = if let Some(ref url) = a.preview_url {
                        if url.starts_with("data:") {
                            let data_part = url.split(',').nth(1).map(|s| s.to_string());
                            let is_text = a.mime_type.starts_with("text/")
                                || a.mime_type == "application/json"
                                || a.mime_type == "application/xml";
                            if is_text {
                                (
                                    None,
                                    data_part.and_then(|d| {
                                        use base64::Engine;
                                        base64::engine::general_purpose::STANDARD
                                            .decode(&d)
                                            .ok()
                                            .and_then(|bytes| String::from_utf8(bytes).ok())
                                    }),
                                )
                            } else {
                                (data_part, None)
                            }
                        } else {
                            (None, None)
                        }
                    } else {
                        (None, None)
                    };

                    Some(AttachmentInput {
                        name: a.name.clone(),
                        mime_type: a.mime_type.clone(),
                        base64_content,
                        text_content,
                        metadata: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let (resolved_content, context_attachments) =
        resolve_context_snapshot_for_variant_retry(vfs_db, user_message, &user_content);
    let user_content = resolved_content;
    let user_attachments = if context_attachments.is_empty() {
        base_user_attachments
    } else {
        base_user_attachments
            .into_iter()
            .chain(context_attachments)
            .collect()
    };

    // 14. 获取或构建 SharedContext（从助手消息恢复）
    let shared_context = message.shared_context.clone().unwrap_or_else(|| {
        // 如果没有 shared_context，从 meta.sources 构建
        if let Some(ref meta) = message.meta {
            if let Some(ref sources) = meta.sources {
                SharedContext {
                    rag_sources: sources.rag.clone(),
                    memory_sources: sources.memory.clone(),
                    graph_sources: sources.graph.clone(),
                    web_search_sources: sources.web_search.clone(),
                    multimodal_sources: sources.multimodal.clone(),
                    // 🔧 P1修复：block_ids 在恢复时为 None（历史数据可能没有）
                    rag_block_id: None,
                    memory_block_id: None,
                    graph_block_id: None,
                    web_search_block_id: None,
                    multimodal_block_id: None,
                }
            } else {
                SharedContext::default()
            }
        } else {
            SharedContext::default()
        }
    });

    // 15. 构建 SendOptions（优先使用前端透传的完整选项）
    let saved_chat_params = message.meta.as_ref().and_then(|m| m.chat_params.as_ref());
    let options = resolve_retry_options(saved_chat_params, &model_id, options_override);

    // 释放数据库连接，避免在 Pipeline 执行期间持有连接
    drop(conn);

    info!(
        "[ChatV2::VariantHandler] Starting variant retry pipeline: message_id={}, variant_id={}, model={}",
        message_id, variant_id, model_id
    );

    // 16. 注册会话级流锁 + 变体取消令牌
    let session_token = match chat_v2_state.try_register_stream(&session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Cannot retry variant while session is streaming. Please wait for completion or cancel first.".to_string()
            ).into());
        }
    };
    let cancel_key = format!("{}:{}", session_id, variant_id);
    let cancel_token = session_token.child_token();
    chat_v2_state.register_existing_token(&cancel_key, cancel_token.clone());

    // 17. 触发 Pipeline 重新执行
    let result = pipeline
        .execute_variant_retry(
            window,
            session_id.clone(),
            message_id.to_string(),
            variant_id.to_string(),
            model_id,
            user_content,
            user_attachments,
            shared_context,
            options,
            cancel_token,
        )
        .await;

    // 18. 清理取消令牌
    chat_v2_state.remove_stream(&cancel_key);
    chat_v2_state.remove_stream(&session_id);

    result
}

async fn retry_variants_impl(
    db: &ChatV2Database,
    vfs_db: &VfsDatabase,
    chat_v2_state: &Arc<ChatV2State>,
    pipeline: &ChatV2Pipeline,
    window: Window,
    message_id: &str,
    variant_ids: &[String],
    options_override: Option<SendOptions>,
) -> ChatV2Result<()> {
    if variant_ids.is_empty() {
        return Err(ChatV2Error::Validation(
            "No variant IDs provided for retry".to_string(),
        ));
    }

    let conn = db.get_conn_safe()?;

    // 1. 获取助手消息
    let mut message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

    // 2. 验证是助手消息
    if message.role != MessageRole::Assistant {
        return Err(ChatV2Error::Validation(
            "Can only retry variants on assistant messages".to_string(),
        ));
    }

    // 🔒 沿用单变体逻辑：检查会话是否有活跃流
    let session_id = message.session_id.clone();
    if chat_v2_state.has_active_stream(&session_id) {
        return Err(ChatV2Error::Other(
            "Cannot retry variants while session is streaming. Please wait for completion or cancel first.".to_string()
        ).into());
    }

    // 3. 去重 variant_ids（保持顺序）
    let mut seen_ids = HashSet::new();
    let mut unique_variant_ids: Vec<String> = Vec::new();
    for id in variant_ids {
        if seen_ids.insert(id.clone()) {
            unique_variant_ids.push(id.clone());
        }
    }

    if unique_variant_ids.is_empty() {
        return Err(ChatV2Error::Validation(
            "No unique variant IDs provided for retry".to_string(),
        ));
    }

    // 4. 校验并收集重试信息
    let variants = message
        .variants
        .as_ref()
        .ok_or_else(|| ChatV2Error::VariantNotFound(unique_variant_ids[0].clone()))?;

    let mut retry_specs: Vec<VariantRetrySpec> = Vec::with_capacity(unique_variant_ids.len());
    let mut blocks_to_delete: HashSet<String> = HashSet::new();

    for variant_id in &unique_variant_ids {
        let variant = variants
            .iter()
            .find(|v| v.id == *variant_id)
            .ok_or_else(|| ChatV2Error::VariantNotFound(variant_id.to_string()))?;

        // streaming 不能重试
        if variant.status == variant_status::STREAMING {
            return Err(ChatV2Error::VariantAlreadyStreaming(variant_id.to_string()));
        }

        // 允许 success 变体重试（仅批量接口）
        if variant.status != variant_status::SUCCESS && !variant.can_retry() {
            return Err(ChatV2Error::VariantCannotRetry(
                variant_id.to_string(),
                variant.status.clone(),
            ));
        }

        // display_model_id 用于前端展示，config_id 用于 LLM 调用
        let display_model_id = variant.model_id.clone();
        let config_id = variant
            .config_id
            .clone()
            .unwrap_or_else(|| variant.model_id.clone());

        retry_specs.push(VariantRetrySpec {
            variant_id: variant_id.clone(),
            model_id: display_model_id.clone(),
            config_id: config_id.clone(),
        });

        for block_id in &variant.block_ids {
            blocks_to_delete.insert(block_id.clone());
        }
    }

    // 5. 删除旧块
    for block_id in &blocks_to_delete {
        if let Err(e) = ChatV2Repo::delete_block_with_conn(&conn, block_id) {
            warn!(
                "[ChatV2::VariantHandler] Failed to delete old block {}: {}",
                block_id, e
            );
        }
    }

    // 6. 重置变体状态
    if let Some(ref mut variants) = message.variants {
        for spec in &retry_specs {
            if let Some(variant) = variants.iter_mut().find(|v| v.id == spec.variant_id) {
                variant.block_ids.clear();
                variant.status = variant_status::PENDING.to_string();
                variant.error = None;
                variant.model_id = spec.model_id.clone();
            }
        }
    }

    // 7. 更新消息的 block_ids（移除已删除的块）
    message
        .block_ids
        .retain(|id| !blocks_to_delete.contains(id));

    // 8. 持久化变体重置
    ChatV2Repo::update_message_with_conn(&conn, &message)?;

    // 9. 获取原始用户消息（查找助手消息之前的用户消息）
    let session_messages = ChatV2Repo::get_session_messages_with_conn(&conn, &session_id)?;

    let user_message = session_messages
        .iter()
        .rev()
        .skip_while(|m| m.id != message_id)
        .skip(1)
        .find(|m| m.role == MessageRole::User)
        .ok_or_else(|| {
            ChatV2Error::Validation("Cannot find original user message for retry".to_string())
        })?;

    // 10. 获取用户消息内容
    let user_blocks = ChatV2Repo::get_message_blocks_with_conn(&conn, &user_message.id)?;
    let user_content = user_blocks
        .iter()
        .filter(|b| b.block_type == "content")
        .filter_map(|b| b.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("");

    if user_content.is_empty() {
        return Err(ChatV2Error::Validation(
            "Original user message has no content".to_string(),
        ));
    }

    // 11. 转换用户附件为 AttachmentInput
    let base_user_attachments: Vec<AttachmentInput> = user_message
        .attachments
        .as_ref()
        .map(|attachments| {
            attachments
                .iter()
                .filter_map(|a| {
                    let (base64_content, text_content) = if let Some(ref url) = a.preview_url {
                        if url.starts_with("data:") {
                            let data_part = url.split(',').nth(1).map(|s| s.to_string());
                            let is_text = a.mime_type.starts_with("text/")
                                || a.mime_type == "application/json"
                                || a.mime_type == "application/xml";
                            if is_text {
                                (
                                    None,
                                    data_part.and_then(|d| {
                                        use base64::Engine;
                                        base64::engine::general_purpose::STANDARD
                                            .decode(&d)
                                            .ok()
                                            .and_then(|bytes| String::from_utf8(bytes).ok())
                                    }),
                                )
                            } else {
                                (data_part, None)
                            }
                        } else {
                            (None, None)
                        }
                    } else {
                        (None, None)
                    };

                    Some(AttachmentInput {
                        name: a.name.clone(),
                        mime_type: a.mime_type.clone(),
                        base64_content,
                        text_content,
                        metadata: None,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let (resolved_content, context_attachments) =
        resolve_context_snapshot_for_variant_retry(vfs_db, user_message, &user_content);
    let user_content = resolved_content;
    let user_attachments = if context_attachments.is_empty() {
        base_user_attachments
    } else {
        base_user_attachments
            .into_iter()
            .chain(context_attachments)
            .collect()
    };

    // 12. 获取或构建 SharedContext（从助手消息恢复）
    let shared_context = message.shared_context.clone().unwrap_or_else(|| {
        if let Some(ref meta) = message.meta {
            if let Some(ref sources) = meta.sources {
                SharedContext {
                    rag_sources: sources.rag.clone(),
                    memory_sources: sources.memory.clone(),
                    graph_sources: sources.graph.clone(),
                    web_search_sources: sources.web_search.clone(),
                    multimodal_sources: sources.multimodal.clone(),
                    rag_block_id: None,
                    memory_block_id: None,
                    graph_block_id: None,
                    web_search_block_id: None,
                    multimodal_block_id: None,
                }
            } else {
                SharedContext::default()
            }
        } else {
            SharedContext::default()
        }
    });

    // 13. 构建 SendOptions（优先使用前端透传的完整选项）
    let primary_model_id = retry_specs
        .first()
        .map(|spec| spec.config_id.clone())
        .unwrap_or_default();
    let saved_chat_params = message.meta.as_ref().and_then(|m| m.chat_params.as_ref());
    let options = resolve_retry_options(saved_chat_params, &primary_model_id, options_override);

    // 释放数据库连接，避免在 Pipeline 执行期间持有连接
    drop(conn);

    info!(
        "[ChatV2::VariantHandler] Starting batch variant retry pipeline: message_id={}, variants={}",
        message_id,
        retry_specs.len()
    );

    let session_token = match chat_v2_state.try_register_stream(&session_id) {
        Ok(token) => token,
        Err(()) => {
            return Err(ChatV2Error::Other(
                "Cannot retry variants while session is streaming. Please wait for completion or cancel first.".to_string()
            ).into());
        }
    };

    let result = pipeline
        .execute_variants_retry_batch(
            window,
            session_id.clone(),
            message_id.to_string(),
            retry_specs,
            user_content,
            user_attachments,
            shared_context,
            options,
            session_token,
            Some(Arc::clone(chat_v2_state)),
        )
        .await;

    for variant_id in &unique_variant_ids {
        let cancel_key = format!("{}:{}", session_id, variant_id);
        chat_v2_state.remove_stream(&cancel_key);
    }
    chat_v2_state.remove_stream(&session_id);

    result
}

/// 取消变体生成
///
/// 取消正在进行的变体流式生成。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `variant_id`: 要取消的变体 ID
#[tauri::command]
pub async fn chat_v2_cancel_variant(
    state: State<'_, Arc<ChatV2State>>,
    session_id: String,
    variant_id: String,
) -> Result<(), String> {
    info!(
        "[ChatV2::VariantHandler] cancel_variant: session_id={}, variant_id={}",
        session_id, variant_id
    );

    cancel_variant_impl(&state, &session_id, &variant_id)
        .await
        .map_err(|e| e.to_string())
}

async fn cancel_variant_impl(
    state: &ChatV2State,
    session_id: &str,
    variant_id: &str,
) -> ChatV2Result<()> {
    // 尝试取消会话级别的流式生成
    // 注意：当前 ChatV2State 是按 session_id 管理取消令牌的
    // 在完整的多变体实现中，需要按 variant_id 管理取消令牌
    // 这里先使用 session_id 级别的取消

    // 构造一个复合键（session_id + variant_id）用于查找
    // 或者直接使用 session_id（如果每个会话同一时间只有一个活跃流）
    let cancel_key = format!("{}:{}", session_id, variant_id);

    // 先尝试用复合键取消
    if state.cancel_stream(&cancel_key) {
        info!(
            "[ChatV2::VariantHandler] Variant cancelled: session_id={}, variant_id={}",
            session_id, variant_id
        );
        return Ok(());
    }

    // 不再回退取消整个 session，避免误取消同会话其他并行变体
    // 如果没有找到活跃流，记录调试日志但不报错（可能已自然结束）
    // 因为流可能已经完成或被取消
    debug!(
        "[ChatV2::VariantHandler] No active stream found for session_id={}, variant_id={}",
        session_id, variant_id
    );

    Ok(())
}

// ============================================================================
// 内部辅助函数
// ============================================================================

fn resolve_context_snapshot_for_variant_retry(
    vfs_db: &VfsDatabase,
    message: &ChatMessage,
    original_content: &str,
) -> (String, Vec<AttachmentInput>) {
    let context_snapshot = message
        .meta
        .as_ref()
        .and_then(|meta| meta.context_snapshot.as_ref());

    let snapshot = match context_snapshot {
        Some(snapshot) if !snapshot.user_refs.is_empty() => snapshot,
        _ => return (original_content.to_string(), Vec::new()),
    };

    let conn = match vfs_db.get_conn_safe() {
        Ok(c) => c,
        Err(e) => {
            warn!(
                "[ChatV2::VariantHandler] Failed to get vfs.db connection for context snapshot: {}",
                e
            );
            return (original_content.to_string(), Vec::new());
        }
    };

    let blobs_dir = vfs_db.blobs_dir();
    let mut total_result = ResolvedContent::new();

    for context_ref in &snapshot.user_refs {
        let resource = VfsResourceRepo::get_by_hash_with_conn(&conn, &context_ref.hash)
            .ok()
            .flatten()
            .or_else(|| {
                VfsResourceRepo::get_resource_with_conn(&conn, &context_ref.resource_id)
                    .ok()
                    .flatten()
            });

        let Some(res) = resource else {
            warn!(
                "[ChatV2::VariantHandler] Resource not found for context ref: {}",
                context_ref.resource_id
            );
            continue;
        };

        let data_str = match &res.data {
            Some(d) => d,
            None => {
                debug!(
                    "[ChatV2::VariantHandler] Resource {} has no data",
                    context_ref.resource_id
                );
                continue;
            }
        };

        if let Ok(mut ref_data) = serde_json::from_str::<VfsContextRefData>(data_str) {
            if let Some(ref saved_inject_modes) = context_ref.inject_modes {
                for vfs_ref in &mut ref_data.refs {
                    vfs_ref.inject_modes = Some(saved_inject_modes.clone());
                }
            }
            let content = resolve_context_ref_data_to_content(&conn, blobs_dir, &ref_data, false);
            total_result.merge(content);
        } else {
            match context_ref.type_id.as_str() {
                "note" | "translation" | "essay" => {
                    if !data_str.is_empty() {
                        let title = res
                            .metadata
                            .as_ref()
                            .and_then(|m| m.title.clone())
                            .unwrap_or_else(|| context_ref.type_id.clone());
                        total_result.add_text(format!(
                            "<injected_context>\n[{}]\n{}\n</injected_context>",
                            title, data_str
                        ));
                    }
                }
                _ => {
                    debug!(
                        "[ChatV2::VariantHandler] Unsupported context ref type for inline content: {}",
                        context_ref.type_id
                    );
                }
            }
        }
    }

    let merged_content = total_result.to_formatted_text(original_content);
    let image_attachments = total_result
        .image_base64_list
        .iter()
        .enumerate()
        .map(|(idx, base64)| AttachmentInput {
            name: format!("context_image_{}", idx + 1),
            mime_type: "image/png".to_string(),
            base64_content: Some(base64.clone()),
            text_content: None,
            metadata: None,
        })
        .collect::<Vec<_>>();

    (merged_content, image_attachments)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::types::{ChatMessage, McpToolSchema, MessageRole, SendOptions, Variant};

    fn create_test_message_with_variants() -> ChatMessage {
        let message = ChatMessage {
            id: "msg_test_123".to_string(),
            session_id: "sess_test_456".to_string(),
            role: MessageRole::Assistant,
            block_ids: vec!["blk_1".to_string(), "blk_2".to_string()],
            timestamp: chrono::Utc::now().timestamp_millis(),
            persistent_stable_id: None,
            parent_id: None,
            supersedes: None,
            meta: None,
            attachments: None,
            active_variant_id: Some("var_1".to_string()),
            variants: Some(vec![
                Variant {
                    id: "var_1".to_string(),
                    model_id: "model_a".to_string(),
                    config_id: None,
                    block_ids: vec!["blk_1".to_string()],
                    status: variant_status::SUCCESS.to_string(),
                    error: None,
                    created_at: chrono::Utc::now().timestamp_millis(),
                    usage: None,
                },
                Variant {
                    id: "var_2".to_string(),
                    model_id: "model_b".to_string(),
                    config_id: None,
                    block_ids: vec!["blk_2".to_string()],
                    status: variant_status::ERROR.to_string(),
                    error: Some("Test error".to_string()),
                    created_at: chrono::Utc::now().timestamp_millis(),
                    usage: None,
                },
            ]),
            shared_context: None,
        };
        message
    }

    #[test]
    fn test_variant_can_activate() {
        let message = create_test_message_with_variants();
        let variants = message.variants.as_ref().unwrap();

        // var_1 is SUCCESS, can activate
        assert!(variants[0].can_activate());

        // var_2 is ERROR, cannot activate
        assert!(!variants[1].can_activate());
    }

    #[test]
    fn test_variant_can_retry() {
        let message = create_test_message_with_variants();
        let variants = message.variants.as_ref().unwrap();

        // var_1 is SUCCESS, cannot retry
        assert!(!variants[0].can_retry());

        // var_2 is ERROR, can retry
        assert!(variants[1].can_retry());
    }

    #[test]
    fn test_get_variant() {
        let message = create_test_message_with_variants();

        assert!(message.get_variant("var_1").is_some());
        assert!(message.get_variant("var_2").is_some());
        assert!(message.get_variant("var_nonexistent").is_none());
    }

    #[test]
    fn test_delete_variant_result_serialization() {
        let result = DeleteVariantResult {
            deleted_variant_id: "var_1".to_string(),
            remaining_count: 1,
            new_active_variant_id: Some("var_2".to_string()),
        };

        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("\"deletedVariantId\""));
        assert!(json.contains("\"remainingCount\""));
        assert!(json.contains("\"newActiveVariantId\""));
    }

    #[test]
    fn test_variant_streaming_status() {
        // streaming 状态的变体不能激活（根据 can_activate 逻辑，streaming 可以激活）
        // 但 streaming 状态的变体不能重试
        let streaming_variant = Variant {
            id: "var_streaming".to_string(),
            model_id: "model_c".to_string(),
            config_id: None,
            block_ids: vec![],
            status: variant_status::STREAMING.to_string(),
            error: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            usage: None,
        };

        // streaming 可以激活（因为不是 error）
        assert!(streaming_variant.can_activate());

        // streaming 不能重试（只有 error/cancelled 可以重试）
        assert!(!streaming_variant.can_retry());
    }

    #[test]
    fn test_variant_cancelled_status() {
        let cancelled_variant = Variant {
            id: "var_cancelled".to_string(),
            model_id: "model_d".to_string(),
            config_id: None,
            block_ids: vec![],
            status: variant_status::CANCELLED.to_string(),
            error: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            usage: None,
        };

        // cancelled 可以激活
        assert!(cancelled_variant.can_activate());

        // cancelled 可以重试
        assert!(cancelled_variant.can_retry());
    }

    #[test]
    fn test_variant_pending_status() {
        let pending_variant = Variant {
            id: "var_pending".to_string(),
            model_id: "model_e".to_string(),
            config_id: None,
            block_ids: vec![],
            status: variant_status::PENDING.to_string(),
            error: None,
            created_at: chrono::Utc::now().timestamp_millis(),
            usage: None,
        };

        // pending 可以激活
        assert!(pending_variant.can_activate());

        // pending 不能重试
        assert!(!pending_variant.can_retry());
    }

    #[test]
    fn test_resolve_retry_options_prefers_frontend_and_keeps_tool_settings() {
        let frontend_options = SendOptions {
            temperature: Some(0.55),
            max_tokens: Some(1234),
            enable_thinking: Some(false),
            mcp_tool_schemas: Some(vec![McpToolSchema {
                name: "builtin-web_search".to_string(),
                description: Some("web search".to_string()),
                input_schema: Some(serde_json::json!({
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" }
                    }
                })),
            }]),
            schema_tool_ids: Some(vec!["builtin-web_search".to_string()]),
            system_prompt_override: Some("override".to_string()),
            ..Default::default()
        };

        let merged = resolve_retry_options(None, "cfg-1", Some(frontend_options));

        assert_eq!(merged.model_id.as_deref(), Some("cfg-1"));
        assert_eq!(merged.model2_override_id.as_deref(), Some("cfg-1"));
        assert_eq!(merged.temperature, Some(0.55));
        assert_eq!(merged.max_tokens, Some(1234));
        assert_eq!(merged.enable_thinking, Some(false));
        assert_eq!(
            merged.schema_tool_ids.as_deref(),
            Some(&["builtin-web_search".to_string()][..])
        );
        assert_eq!(merged.system_prompt_override.as_deref(), Some("override"));
        assert_eq!(
            merged
                .mcp_tool_schemas
                .as_ref()
                .map(|v| v.len())
                .unwrap_or_default(),
            1
        );
    }

    #[test]
    fn test_resolve_retry_options_fallback_to_saved_params() {
        let chat_params = serde_json::json!({
            "temperature": 0.2,
            "maxTokens": 2048,
            "enableThinking": true
        });

        let merged = resolve_retry_options(Some(&chat_params), "cfg-2", None);

        assert_eq!(merged.model_id.as_deref(), Some("cfg-2"));
        assert_eq!(merged.model2_override_id.as_deref(), Some("cfg-2"));
        assert_eq!(merged.temperature, Some(0.2));
        assert_eq!(merged.max_tokens, Some(2048));
        assert_eq!(merged.enable_thinking, Some(true));
        assert!(merged.mcp_tool_schemas.is_none());
        assert!(merged.schema_tool_ids.is_none());
    }
}
