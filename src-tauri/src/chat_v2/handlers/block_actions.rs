//! 块操作命令处理器
//!
//! 包含删除消息和复制块内容等命令。

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::events::{event_phase, event_types, next_session_sequence_id};
use crate::chat_v2::handlers::manage_session::rebuild_session_skill_state_from_surviving_history;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::state::ChatV2State;
use crate::chat_v2::types::{ChatMessage, MessageRole};
// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db 的 VfsResourceRepo
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsResourceRepo;

/// 复制块内容响应
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyBlockContentResponse {
    /// 复制的内容
    pub content: String,
    /// 内容类型（text/markdown/json）
    pub content_type: String,
}

/// 删除消息
///
/// 删除指定消息及其所有关联的块。
/// 支持级联删除：删除消息时会同时删除其所有块。
///
/// ## 参数
/// - `session_id`: 会话 ID
/// - `message_id`: 消息 ID
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 删除成功
/// - `Err(String)`: 消息不存在或删除失败
///
/// ## 级联删除
/// 删除消息时会自动删除：
/// - `chat_v2_blocks` 表中 `message_id` 匹配的所有块
/// - `chat_v2_messages` 表中的消息记录
#[tauri::command]
pub async fn chat_v2_delete_message(
    session_id: String,
    message_id: String,
    db: State<'_, Arc<ChatV2Database>>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_delete_message: session_id={}, message_id={}",
        session_id,
        message_id
    );

    // 🔒 P0 修复（2026-01-10）：检查会话是否有活跃流
    // 防止流式中删除消息导致 Pipeline save_results() 写入已删除消息失败
    if chat_v2_state.has_active_stream(&session_id) {
        return Err(ChatV2Error::Other(
            "Cannot delete message while streaming. Please wait for completion or cancel first."
                .to_string(),
        )
        .into());
    }

    // 验证消息 ID 格式
    if !message_id.starts_with("msg_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid message ID format: {}", message_id)).into(),
        );
    }

    // 删除消息（包含级联删除块）
    // 🆕 VFS 统一存储：传入 vfs_db 用于减少引用计数
    delete_message_from_db(&session_id, &message_id, &db, &vfs_db)?;

    log::info!(
        "[ChatV2::handlers] Deleted message: session_id={}, message_id={}",
        session_id,
        message_id
    );

    Ok(())
}

/// 复制块内容
///
/// 获取指定块的内容，用于复制到剪贴板。
/// 根据块类型返回不同格式的内容。
///
/// ## 参数
/// - `block_id`: 块 ID
/// - `format`: 可选的输出格式（text/markdown/json），默认为 text
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(CopyBlockContentResponse)`: 块内容和格式
/// - `Err(String)`: 块不存在或读取失败
///
/// ## 格式说明
/// - `text`: 纯文本格式，适合粘贴到普通文本框
/// - `markdown`: Markdown 格式，保留格式信息
/// - `json`: JSON 格式，包含完整块数据
#[tauri::command]
pub async fn chat_v2_copy_block_content(
    block_id: String,
    format: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<CopyBlockContentResponse, String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_copy_block_content: block_id={}, format={:?}",
        block_id,
        format
    );

    // 验证块 ID 格式
    if !block_id.starts_with("blk_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid block ID format: {}", block_id)).into(),
        );
    }

    let output_format = format.unwrap_or_else(|| "text".to_string());

    // 获取块内容
    let response = get_block_content_from_db(&block_id, &output_format, &db)?;

    log::info!(
        "[ChatV2::handlers] Copied block content: block_id={}, content_type={}, len={}",
        block_id,
        response.content_type,
        response.content.len()
    );

    Ok(response)
}

// ============================================================================
// 内部辅助函数（调用 ChatV2Repo 实现）
// ============================================================================

/// 从数据库删除消息
///
/// 🔧 优化：使用单一连接避免多次获取锁（遵循规则 #12）
/// 🆕 VFS 统一存储（2025-12-07）：使用 vfs.db 减少引用计数
fn delete_message_from_db(
    session_id: &str,
    message_id: &str,
    db: &ChatV2Database,
    vfs_db: &VfsDatabase,
) -> Result<(), ChatV2Error> {
    // 🔧 优化：在函数开头获取一次连接，后续使用 _with_conn 方法
    let conn = db.get_conn_safe()?;

    // 验证会话存在
    let _ = ChatV2Repo::get_session_with_conn(&conn, session_id)?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.to_string()))?;

    // 验证消息存在且属于该会话
    let message = ChatV2Repo::get_message_with_conn(&conn, message_id)?
        .ok_or_else(|| ChatV2Error::MessageNotFound(message_id.to_string()))?;

    // 检查消息是否属于指定会话
    if message.session_id != session_id {
        return Err(ChatV2Error::Validation(format!(
            "Message {} does not belong to session {}",
            message_id, session_id
        )));
    }

    // 🆕 Prompt 8: 消息删除前减少资源引用计数（统一上下文注入系统）
    // 🆕 VFS 统一存储：使用 vfs.db 而非 resources.db
    // 约束：消息删除时调用 decrementRef
    if let Some(ref meta) = message.meta {
        if let Some(ref context_snapshot) = meta.context_snapshot {
            let resource_ids = context_snapshot.all_resource_ids();
            if !resource_ids.is_empty() {
                // 获取 VFS 数据库连接
                match vfs_db.get_conn_safe() {
                    Ok(vfs_conn) => {
                        // 转换为 String 类型
                        let resource_ids_owned: Vec<String> =
                            resource_ids.iter().map(|s| s.to_string()).collect();
                        // 使用 vfs.db 的连接减少引用计数
                        if let Err(e) = VfsResourceRepo::decrement_refs_with_conn(
                            &vfs_conn,
                            &resource_ids_owned,
                        ) {
                            // 记录警告但不阻止删除
                            log::warn!(
                                "[ChatV2::handlers] Failed to decrement refs for message {}: {}",
                                message_id,
                                e
                            );
                        } else {
                            log::debug!(
                                "[ChatV2::handlers] Decremented refs for {} resources in vfs.db before deleting message {}",
                                resource_ids_owned.len(), message_id
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "[ChatV2::handlers] Failed to get vfs.db connection for decrement refs: {}",
                            e
                        );
                    }
                }
            }
        }
    }

    // 删除消息（级联删除关联的块由外键约束处理）
    // 🔧 优化：使用 _with_conn 版本
    ChatV2Repo::delete_message_with_conn(&conn, message_id)?;
    let _ = rebuild_session_skill_state_from_surviving_history(session_id, db);

    Ok(())
}

/// 从数据库获取块内容
fn get_block_content_from_db(
    block_id: &str,
    format: &str,
    db: &ChatV2Database,
) -> Result<CopyBlockContentResponse, ChatV2Error> {
    // 从数据库获取块
    let block = ChatV2Repo::get_block_v2(db, block_id)?
        .ok_or_else(|| ChatV2Error::BlockNotFound(block_id.to_string()))?;

    // 获取块内容（如果为空则使用默认值）
    let block_content = block.content.unwrap_or_default();

    // 根据格式生成输出
    let (content, content_type) = match format {
        "markdown" => {
            // 返回 Markdown 格式
            (block_content, "markdown".to_string())
        }
        "json" => {
            // 返回 JSON 格式（包含完整块数据）
            let json = serde_json::json!({
                "id": block.id,
                "type": block.block_type,
                "status": block.status,
                "content": block_content,
                "toolName": block.tool_name,
                "toolInput": block.tool_input,
                "toolOutput": block.tool_output,
                "citations": block.citations,
                "error": block.error,
                "startedAt": block.started_at,
                "endedAt": block.ended_at,
            });
            (
                serde_json::to_string_pretty(&json).unwrap_or_default(),
                "json".to_string(),
            )
        }
        _ => {
            // 默认返回纯文本
            (block_content, "text".to_string())
        }
    };

    Ok(CopyBlockContentResponse {
        content,
        content_type,
    })
}

/// 更新块内容
///
/// 更新指定块的文本内容。用于编辑用户消息等场景。
///
/// ## 参数
/// - `block_id`: 块 ID
/// - `content`: 新内容
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 更新成功
/// - `Err(String)`: 块不存在或更新失败
#[tauri::command]
pub async fn chat_v2_update_block_content(
    block_id: String,
    content: String,
    db: State<'_, Arc<ChatV2Database>>,
    chat_v2_state: State<'_, Arc<ChatV2State>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_update_block_content: block_id={}, content_len={}",
        block_id,
        content.len()
    );

    // 验证块 ID 格式
    if !block_id.starts_with("blk_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid block ID format: {}", block_id)).into(),
        );
    }

    // 🔒 P1 修复（2026-01-10）：检查块所属会话是否有活跃流
    // 防止流式中修改历史消息内容导致语义不一致
    let existing_block = ChatV2Repo::get_block_v2(&db, &block_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::BlockNotFound(block_id.clone()).to_string())?;

    // 从块获取消息，从消息获取 session_id
    let message = ChatV2Repo::get_message_v2(&db, &existing_block.message_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| {
            ChatV2Error::MessageNotFound(existing_block.message_id.clone()).to_string()
        })?;

    if chat_v2_state.has_active_stream(&message.session_id) {
        return Err(ChatV2Error::Other(
            "Cannot update block content while session is streaming. Please wait for completion or cancel first.".to_string()
        ).into());
    }

    // 更新块内容
    update_block_content_in_db(&block_id, &content, &db)?;

    log::info!(
        "[ChatV2::handlers] Block content updated: block_id={}",
        block_id
    );

    Ok(())
}

/// 更新块的 tool_output（用于前端编辑 anki_cards 卡片后持久化）
///
/// 🔧 修复场景8：前端编辑卡片后调用此命令持久化到数据库，
/// 防止后续 pipeline 重保存消息时丢失用户编辑。
#[tauri::command]
pub async fn chat_v2_update_block_tool_output(
    block_id: String,
    tool_output_json: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_update_block_tool_output: block_id={}, len={}",
        block_id,
        tool_output_json.len()
    );

    if !block_id.starts_with("blk_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid block ID format: {}", block_id)).into(),
        );
    }

    // 验证 JSON 合法性
    let _: serde_json::Value = serde_json::from_str(&tool_output_json)
        .map_err(|e| format!("Invalid tool_output_json: {}", e))?;

    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE chat_v2_blocks SET tool_output_json = ?1 WHERE id = ?2",
        rusqlite::params![tool_output_json, block_id],
    )
    .map_err(|e| format!("Failed to update block tool_output: {}", e))?;

    log::info!(
        "[ChatV2::handlers] Block tool_output updated: block_id={}",
        block_id
    );

    Ok(())
}

/// 根据 document_id 获取聊天块中持久化的 anki_cards（优先返回前端编辑后的版本）
#[tauri::command]
#[allow(non_snake_case)]
pub async fn chat_v2_get_anki_cards_from_block_by_document_id(
    documentId: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<Vec<crate::models::AnkiCard>, String> {
    let doc_id = documentId.trim();
    if doc_id.is_empty() {
        return Err("documentId is required".to_string());
    }

    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT tool_output_json
            FROM chat_v2_blocks
            WHERE block_type = 'anki_cards' AND tool_output_json IS NOT NULL
            ORDER BY rowid DESC
            "#,
        )
        .map_err(|e| format!("Failed to prepare query: {}", e))?;

    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("Failed to query blocks: {}", e))?;

    for row in rows {
        let tool_output_json = row.map_err(|e| format!("Failed to read row: {}", e))?;
        let parsed: serde_json::Value = match serde_json::from_str(&tool_output_json) {
            Ok(value) => value,
            Err(_) => continue,
        };

        let block_doc_id = parsed
            .get("documentId")
            .and_then(|value| value.as_str())
            .unwrap_or_default();
        if block_doc_id != doc_id {
            continue;
        }

        let cards = parsed
            .get("cards")
            .and_then(|value| value.as_array())
            .cloned()
            .unwrap_or_default();

        let converted = cards
            .into_iter()
            .filter_map(|value| serde_json::from_value::<crate::models::AnkiCard>(value).ok())
            .collect::<Vec<_>>();

        return Ok(converted);
    }

    Ok(Vec::new())
}

/// 在数据库中更新块内容
fn update_block_content_in_db(
    block_id: &str,
    content: &str,
    db: &ChatV2Database,
) -> Result<(), ChatV2Error> {
    // 先获取现有块
    let existing = ChatV2Repo::get_block_v2(db, block_id)?
        .ok_or_else(|| ChatV2Error::BlockNotFound(block_id.to_string()))?;

    // 构建更新后的块（只更新 content 字段）
    let updated_block = crate::chat_v2::types::MessageBlock {
        content: Some(content.to_string()),
        ..existing
    };

    // 更新数据库
    ChatV2Repo::update_block_v2(db, &updated_block)?;

    Ok(())
}

/// 流式过程中保存块内容（UPSERT 语义）
///
/// 用于流式过程中定期保存块内容，防止闪退丢失。
/// - 如果块不存在，创建它
/// - 如果块存在，更新内容
///
/// ## 参数
/// - `block_id`: 块 ID
/// - `message_id`: 消息 ID
/// - `block_type`: 块类型（如 content, thinking）
/// - `content`: 当前累积内容
/// - `status`: 块状态（默认 streaming）
/// - `db`: Chat V2 独立数据库
///
/// ## 返回
/// - `Ok(())`: 保存成功
/// - `Err(String)`: 保存失败
#[tauri::command]
pub async fn chat_v2_upsert_streaming_block(
    block_id: String,
    message_id: String,
    session_id: Option<String>,
    block_type: String,
    content: String,
    status: Option<String>,
    // 🔧 P35: 扩展支持工具块持久化
    tool_name: Option<String>,
    tool_input_json: Option<String>,
    tool_output_json: Option<String>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<(), String> {
    log::info!(
        "[ChatV2::handlers] chat_v2_upsert_streaming_block: block_id={}, message_id={}, session_id={:?}, type={}, content_len={}, has_tool={}",
        block_id,
        message_id,
        session_id,
        block_type,
        content.len(),
        tool_name.is_some()
    );

    // 验证块 ID 格式
    if !block_id.starts_with("blk_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid block ID format: {}", block_id)).into(),
        );
    }

    // 验证消息 ID 格式
    if !message_id.starts_with("msg_") {
        return Err(
            ChatV2Error::Validation(format!("Invalid message ID format: {}", message_id)).into(),
        );
    }

    // 🔧 P35: 解析工具输入/输出 JSON
    let tool_input: Option<serde_json::Value> = tool_input_json
        .as_ref()
        .map(|s| serde_json::from_str(s))
        .transpose()
        .map_err(|e| format!("Invalid tool_input_json: {}", e))?;
    let tool_output: Option<serde_json::Value> = tool_output_json
        .as_ref()
        .map(|s| serde_json::from_str(s))
        .transpose()
        .map_err(|e| format!("Invalid tool_output_json: {}", e))?;

    // 构建块对象
    let now_ms = chrono::Utc::now().timestamp_millis();
    let block = crate::chat_v2::types::MessageBlock {
        id: block_id.clone(),
        message_id,
        block_type,
        status: status.unwrap_or_else(|| crate::chat_v2::types::block_status::RUNNING.to_string()),
        content: if content.is_empty() {
            None
        } else {
            Some(content)
        },
        tool_name,
        tool_input,
        tool_output,
        citations: None,
        error: None,
        started_at: Some(now_ms),
        ended_at: Some(now_ms), // 🔧 P35: 工具块已完成，设置 ended_at
        // 🔧 流式块：第一次创建时记录 first_chunk_at
        first_chunk_at: Some(now_ms),
        block_index: 0, // 流式块不需要排序，使用默认值
    };

    // 先确保消息占位行存在（FK 约束要求消息先于块存在）
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    if let Err(e) =
        ensure_message_exists_with_block(&conn, session_id.as_deref(), &block.message_id, &block.id)
    {
        log::warn!(
            "[ChatV2::handlers] Failed to ensure placeholder message for streaming block: {}",
            e
        );
    }

    // 再 UPSERT 块到数据库（消息已存在，FK 不会违反）
    upsert_block_in_db(&block, &db)?;

    // 追加 block_id 到消息的 block_ids
    if let Err(e) = append_block_id_to_message(&conn, &block.message_id, &block.id) {
        log::warn!(
            "[ChatV2::handlers] Failed to append block_id to message: {}",
            e
        );
    }

    log::info!(
        "[ChatV2::handlers] Streaming block upserted: block_id={}, message_id={}",
        block_id,
        block.message_id
    );

    Ok(())
}

/// 🔧 P35 批判性修复：追加块 ID 到消息的 block_ids_json
///
/// 如果消息存在，追加 block_id；如果消息不存在，忽略（流式块场景）
fn append_block_id_to_message(
    conn: &rusqlite::Connection,
    message_id: &str,
    block_id: &str,
) -> Result<(), ChatV2Error> {
    // 尝试读取现有的 block_ids
    let existing_block_ids: Result<Option<String>, _> = conn.query_row(
        "SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1",
        rusqlite::params![message_id],
        |row| row.get(0),
    );

    match existing_block_ids {
        Ok(block_ids_json) => {
            // 消息存在，追加 block_id
            let mut block_ids: Vec<String> = block_ids_json
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();

            // 避免重复添加
            if !block_ids.contains(&block_id.to_string()) {
                block_ids.push(block_id.to_string());

                let block_ids_json = serde_json::to_string(&block_ids)?;

                conn.execute(
                    "UPDATE chat_v2_messages SET block_ids_json = ?1 WHERE id = ?2",
                    rusqlite::params![block_ids_json, message_id],
                )?;

                log::info!(
                    "[ChatV2::handlers] ✅ Appended block_id {} to message {}, new_block_ids={}",
                    block_id,
                    message_id,
                    block_ids_json
                );
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => {
            // 消息不存在，忽略（流式块场景，消息稍后会创建）
            log::warn!(
                "[ChatV2::handlers] ⚠️ Message {} not found, skipping block_ids update for block {}",
                message_id, block_id
            );
        }
        Err(e) => {
            log::warn!(
                "[ChatV2::handlers] Failed to read message {}: {}",
                message_id,
                e
            );
        }
    }

    Ok(())
}

/// 🔧 防闪退补齐：消息缺失时创建占位消息，避免块孤儿
fn ensure_message_exists_with_block(
    conn: &rusqlite::Connection,
    session_id: Option<&str>,
    message_id: &str,
    block_id: &str,
) -> Result<bool, ChatV2Error> {
    if ChatV2Repo::get_message_with_conn(conn, message_id)?.is_some() {
        return Ok(false);
    }

    let session_id = match session_id {
        Some(id) if !id.is_empty() => id,
        _ => {
            log::warn!(
                "[ChatV2::handlers] Missing session_id for streaming block: message_id={}",
                message_id
            );
            return Ok(false);
        }
    };

    let now_ms = chrono::Utc::now().timestamp_millis();
    let placeholder_message = ChatMessage {
        id: message_id.to_string(),
        session_id: session_id.to_string(),
        role: MessageRole::Assistant,
        block_ids: vec![block_id.to_string()],
        timestamp: now_ms,
        persistent_stable_id: None,
        parent_id: None,
        supersedes: None,
        meta: None,
        attachments: None,
        active_variant_id: None,
        variants: None,
        shared_context: None,
    };

    ChatV2Repo::create_message_with_conn(conn, &placeholder_message)?;
    log::info!(
        "[ChatV2::handlers] Created placeholder message for streaming block: message_id={}, block_id={}",
        message_id,
        block_id
    );

    Ok(true)
}

/// 在数据库中 UPSERT 块（防闪退保存专用）
///
/// 🔧 关键设计：临时禁用外键约束
///
/// 流式过程中，助手消息还未保存到数据库，但我们需要先保存块内容以防闪退。
/// 正常流式结束后，`save_results` 会保存完整的消息和块，覆盖这里的临时数据。
///
/// 如果闪退：
/// - 块数据已保存，可恢复部分内容
/// - 消息数据缺失，需要在恢复时处理孤儿块
fn upsert_block_in_db(
    block: &crate::chat_v2::types::MessageBlock,
    db: &ChatV2Database,
) -> Result<(), ChatV2Error> {
    let conn = db.get_conn_safe()?;

    let tool_input_json = block
        .tool_input
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()?;
    let tool_output_json = block
        .tool_output
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()?;
    let citations_json = block
        .citations
        .as_ref()
        .map(|v| serde_json::to_string(v))
        .transpose()?;

    conn.execute(
        r#"
        INSERT INTO chat_v2_blocks
        (id, message_id, block_type, status, block_index, content, tool_name, tool_input_json, tool_output_json, citations_json, error, started_at, ended_at, first_chunk_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
        ON CONFLICT(id) DO UPDATE SET
            message_id = excluded.message_id,
            block_type = excluded.block_type,
            status = excluded.status,
            block_index = excluded.block_index,
            content = excluded.content,
            tool_name = excluded.tool_name,
            tool_input_json = excluded.tool_input_json,
            tool_output_json = excluded.tool_output_json,
            citations_json = excluded.citations_json,
            error = excluded.error,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            first_chunk_at = excluded.first_chunk_at
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
    )?;

    // 🔧 P35 批判性修复：更新消息的 block_ids_json，确保块被正确关联
    // 如果不更新，刷新后加载消息时 block_ids_json 中没有这个块 ID，块不会被渲染
    append_block_id_to_message(&conn, &block.message_id, &block.id)?;

    Ok(())
}

// ============================================================================
// Anki 卡片结果处理（CardAgent 回调）
// ============================================================================

/// Anki 卡片结果请求
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCardsResultRequest {
    /// 会话 ID
    pub session_id: String,
    /// 消息 ID（来自工具调用时传递的 messageId）
    pub message_id: String,
    /// 块 ID（来自工具调用时传递的 blockId，将被替换为新的 anki_cards 块）
    pub tool_block_id: String,
    /// 生成的卡片列表
    pub cards: Vec<serde_json::Value>,
    /// 文档 ID（用于后续查询进度）
    pub document_id: Option<String>,
    /// 模板 ID
    pub template_id: Option<String>,
    /// 是否成功
    pub success: bool,
    /// 错误信息（失败时）
    pub error: Option<String>,
}

/// 接收 Anki 卡片生成结果
///
/// 由前端 CardAgent 在完成卡片生成后调用，用于：
/// 1. 创建 anki_cards 块显示在聊天中
/// 2. 持久化卡片数据到数据库
/// 3. 发射事件通知前端 UI 更新
///
/// ## 参数
/// - `request`: Anki 卡片结果请求
/// - `db`: Chat V2 独立数据库
/// - `app`: Tauri AppHandle（用于发射事件）
///
/// ## 返回
/// - `Ok(String)`: 创建的 anki_cards 块 ID
/// - `Err(String)`: 创建失败
#[tauri::command]
pub async fn chat_v2_anki_cards_result(
    request: AnkiCardsResultRequest,
    db: State<'_, Arc<ChatV2Database>>,
    app: AppHandle,
) -> Result<String, String> {
    use tauri::Emitter;

    log::info!(
        "[ChatV2::handlers] chat_v2_anki_cards_result: session_id={}, message_id={}, cards_count={}, success={}",
        request.session_id,
        request.message_id,
        request.cards.len(),
        request.success
    );

    // 验证消息 ID 格式
    if !request.message_id.starts_with("msg_") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid message ID format: {}",
            request.message_id
        ))
        .into());
    }

    // 生成新的 anki_cards 块 ID
    let block_id = format!("blk_{}", uuid::Uuid::new_v4());
    let now_ms = chrono::Utc::now().timestamp_millis();

    // 构建 toolOutput（与前端 AnkiCardsBlockData 兼容）
    let tool_output = serde_json::json!({
        "cards": request.cards,
        "documentId": request.document_id,
        "templateId": request.template_id,
        "syncStatus": "pending",
        "businessSessionId": request.session_id,
        "messageStableId": request.message_id,
    });

    // 确定块状态
    let status = if request.success {
        crate::chat_v2::types::block_status::SUCCESS.to_string()
    } else {
        crate::chat_v2::types::block_status::ERROR.to_string()
    };

    // 构建 anki_cards 块
    let block = crate::chat_v2::types::MessageBlock {
        id: block_id.clone(),
        message_id: request.message_id.clone(),
        block_type: crate::chat_v2::types::block_types::ANKI_CARDS.to_string(),
        status: status.clone(),
        content: None,
        tool_name: Some("anki_generate_cards".to_string()),
        tool_input: None,
        tool_output: Some(tool_output.clone()),
        citations: None,
        error: request.error.clone(),
        started_at: Some(now_ms),
        ended_at: Some(now_ms),
        first_chunk_at: Some(now_ms),
        block_index: 1, // 放在 mcp_tool 块之后
    };

    // 保存到数据库
    upsert_block_in_db(&block, &db).map_err(|e| e.to_string())?;

    // 🆕 2026-01: 发射 anki_cards 事件到前端，通知 UI 更新
    // 使用会话特定的事件通道
    let event_channel = format!("chat_v2_event_{}", request.session_id);

    let start_sequence_id = next_session_sequence_id(&request.session_id);
    // 发射 start 事件
    let start_event = serde_json::json!({
        "sequenceId": start_sequence_id,
        "type": event_types::ANKI_CARDS,
        "phase": event_phase::START,
        "messageId": request.message_id,
        "blockId": block_id,
        "payload": {
            "templateId": request.template_id,
        },
    });
    if let Err(e) = app.emit(&event_channel, &start_event) {
        log::warn!(
            "[ChatV2::handlers] Failed to emit anki_cards start event: {}",
            e
        );
    }

    let end_sequence_id = next_session_sequence_id(&request.session_id);
    // 发射 end 事件（带完整卡片数据）
    let end_event = serde_json::json!({
        "sequenceId": end_sequence_id,
        "type": event_types::ANKI_CARDS,
        "phase": event_phase::END,
        "blockId": block_id,
        "result": tool_output,
        "status": status,
        "error": request.error,
    });
    if let Err(e) = app.emit(&event_channel, &end_event) {
        log::warn!(
            "[ChatV2::handlers] Failed to emit anki_cards end event: {}",
            e
        );
    }

    log::info!(
        "[ChatV2::handlers] Anki cards block created and event emitted: block_id={}, cards_count={}",
        block_id,
        request.cards.len()
    );

    Ok(block_id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn test_block_id_validation() {
        assert!("blk_12345".starts_with("blk_"));
        assert!("blk_a1b2c3d4-e5f6-7890-abcd-ef1234567890".starts_with("blk_"));
        assert!(!"block_12345".starts_with("blk_"));
        assert!(!"invalid".starts_with("blk_"));
    }

    #[test]
    fn test_message_id_validation() {
        assert!("msg_12345".starts_with("msg_"));
        assert!("msg_a1b2c3d4-e5f6-7890-abcd-ef1234567890".starts_with("msg_"));
        assert!(!"message_12345".starts_with("msg_"));
        assert!(!"invalid".starts_with("msg_"));
    }
}
