//! 对话快照导出/导入命令处理器
//!
//! 设计文档: docs/conversation-snapshot-import-and-hidden-commands-2026-08-10.md
//!
//! ## 功能
//! - `chat_v2_export_session_meta`: 导出会话元信息（会话行 + 会话状态 + 消息总数）
//! - `chat_v2_export_session_messages`: 分页导出消息与块（分块导出，避免超大会话撑爆 IPC）
//! - `chat_v2_import_session`: 导入快照 JSON，全部 ID 重映射为新 ID 后事务写入
//!
//! ## 快照格式 (Conversation Snapshot v1)
//! ```jsonc
//! {
//!   "format": "deepstudent-conversation-snapshot",
//!   "version": 1,
//!   "exportedAt": "...", "appVersion": "...",
//!   "session": { ... },            // ChatSession
//!   "sessionState": { ... },       // SessionState, 可空
//!   "messages": [ ... ],           // ChatMessage[] (variants_json 内含多模型结果)
//!   "blocks": [ ... ]              // MessageBlock[]
//! }
//! ```
//!
//! ## 关键决策
//! - 多模型返回结果存于 messages.variants_json（Variant 数组）+ blocks.variant_id 冗余列，
//!   导出即原样带出，导入时 Variant.id 一并重映射
//! - **ID 必须全部重映射** — 直接保留原 ID 会与同步 change_log 冲突（同一 ID 在两台设备各自演化）
//! - 附件 blob 不内联（attachments_json 只有元数据；chat_v2_attachments 表生产未使用）
//! - compactions / todo_lists / session_mistakes 不导出（工作区级数据，v1 范围外）

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{
    ChatMessage, ChatSession, MessageBlock, PersistStatus, SessionState, SharedContext, Variant,
};

use super::manage_session::remap_ids_in_value;

/// 快照格式标识
pub const SNAPSHOT_FORMAT: &str = "deepstudent-conversation-snapshot";
/// 当前快照版本
pub const SNAPSHOT_VERSION: u32 = 1;
/// 分块导出默认每页消息数
pub const EXPORT_PAGE_SIZE: usize = 100;

// ============================================================================
// 导出
// ============================================================================

/// 导出元信息（第一块）：会话行 + 会话状态 + 分页参数
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionMeta {
    pub format: String,
    pub version: u32,
    pub exported_at: String,
    pub app_version: String,
    pub session: ChatSession,
    pub session_state: Option<SessionState>,
    pub message_count: usize,
    pub page_size: usize,
}

/// 消息分块（第 N 块）：一页消息 + 这些消息的全部块
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMessagesChunk {
    pub messages: Vec<ChatMessage>,
    pub blocks: Vec<MessageBlock>,
    /// 下一页偏移；None 表示已是最后一页
    pub next_offset: Option<usize>,
}

/// 导出会话元信息
#[tauri::command]
pub async fn chat_v2_export_session_meta(
    session_id: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ExportSessionMeta, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

    let session = ChatV2Repo::get_session_with_conn(&conn, &session_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| ChatV2Error::SessionNotFound(session_id.clone()).to_string())?;

    let session_state =
        ChatV2Repo::load_session_state_with_conn(&conn, &session_id).map_err(|e| e.to_string())?;

    let messages = ChatV2Repo::get_session_messages_with_conn(&conn, &session_id)
        .map_err(|e| e.to_string())?;

    Ok(ExportSessionMeta {
        format: SNAPSHOT_FORMAT.to_string(),
        version: SNAPSHOT_VERSION,
        exported_at: chrono::Utc::now().to_rfc3339(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        session,
        session_state,
        message_count: messages.len(),
        page_size: EXPORT_PAGE_SIZE,
    })
}

/// 分页导出会话消息与块
///
/// ## 参数
/// - `offset`: 消息偏移量（按 timestamp ASC, rowid ASC 排序后的下标）
/// - `limit`: 本页消息数上限（None 使用 EXPORT_PAGE_SIZE）
#[tauri::command]
pub async fn chat_v2_export_session_messages(
    session_id: String,
    offset: usize,
    limit: Option<usize>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ExportMessagesChunk, String> {
    let conn = db.get_conn_safe().map_err(|e| e.to_string())?;

    let all_messages = ChatV2Repo::get_session_messages_with_conn(&conn, &session_id)
        .map_err(|e| e.to_string())?;

    let page_size = limit.unwrap_or(EXPORT_PAGE_SIZE).max(1);
    let start = offset.min(all_messages.len());
    let end = (start + page_size).min(all_messages.len());
    let page_messages: Vec<ChatMessage> = all_messages[start..end].to_vec();

    // 按消息归属取块（WHERE message_id = ?，覆盖该消息全部块，含各变体块）
    let mut page_blocks: Vec<MessageBlock> = Vec::new();
    for msg in &page_messages {
        let blocks =
            ChatV2Repo::get_message_blocks_with_conn(&conn, &msg.id).map_err(|e| e.to_string())?;
        page_blocks.extend(blocks);
    }

    let next_offset = if end < all_messages.len() {
        Some(end)
    } else {
        None
    };

    Ok(ExportMessagesChunk {
        messages: page_messages,
        blocks: page_blocks,
        next_offset,
    })
}

// ============================================================================
// 导入
// ============================================================================

/// 快照文件结构（导入侧）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSnapshot {
    pub format: String,
    pub version: u32,
    pub session: ChatSession,
    pub session_state: Option<SessionState>,
    #[serde(default)]
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub blocks: Vec<MessageBlock>,
}

/// 导入结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSessionResult {
    pub session_id: String,
    pub message_count: usize,
    pub block_count: usize,
    pub warnings: Vec<String>,
}

/// 导入对话快照
///
/// 全部 ID 重映射为新 ID（会话/消息/块/变体），作为全新会话副本写入，
/// 防止与库内现有行或同步 change_log 冲突。
///
/// ## 参数
/// - `snapshot_json`: 快照文件完整内容（前端经 fileManager 读取，兼容移动端 content:// 路径）
#[tauri::command]
pub async fn chat_v2_import_session(
    snapshot_json: String,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ImportSessionResult, String> {
    // 1. 解析与校验
    let snapshot: ConversationSnapshot = serde_json::from_str(&snapshot_json).map_err(|e| {
        ChatV2Error::Validation(format!("Invalid snapshot JSON: {}", e)).to_string()
    })?;

    if snapshot.format != SNAPSHOT_FORMAT {
        return Err(ChatV2Error::Validation(format!(
            "Unknown snapshot format: {} (expected {})",
            snapshot.format, SNAPSHOT_FORMAT
        ))
        .to_string());
    }
    if snapshot.version != SNAPSHOT_VERSION {
        return Err(ChatV2Error::Validation(format!(
            "Unsupported snapshot version: {} (supported: {})",
            snapshot.version, SNAPSHOT_VERSION
        ))
        .to_string());
    }

    let mut warnings: Vec<String> = Vec::new();

    // 2. 预生成 ID 映射
    let new_session_id = ChatSession::generate_id();
    let mut msg_id_map: HashMap<String, String> = HashMap::new();
    let mut block_id_map: HashMap<String, String> = HashMap::new();

    for msg in &snapshot.messages {
        msg_id_map.insert(msg.id.clone(), ChatMessage::generate_id());
    }
    // 只接收归属消息在快照内的块；孤儿块跳过并告警
    let mut orphan_blocks = 0usize;
    let valid_blocks: Vec<&MessageBlock> = snapshot
        .blocks
        .iter()
        .filter(|b| {
            let ok = msg_id_map.contains_key(&b.message_id);
            if !ok {
                orphan_blocks += 1;
            }
            ok
        })
        .collect();
    if orphan_blocks > 0 {
        warnings.push(format!(
            "Skipped {} orphan blocks (message not in snapshot)",
            orphan_blocks
        ));
    }
    for block in &valid_blocks {
        block_id_map.insert(block.id.clone(), MessageBlock::generate_id());
    }

    let now = chrono::Utc::now();

    // 3. 新会话行：保留原标题与创建时间，标记导入来源
    let mut metadata = snapshot
        .session
        .metadata
        .clone()
        .unwrap_or_else(|| serde_json::json!({}));
    if let Some(obj) = metadata.as_object_mut() {
        obj.insert(
            "importedFrom".to_string(),
            serde_json::json!({
                "sourceSessionId": snapshot.session.id,
                "importedAt": now.to_rfc3339(),
            }),
        );
    }

    let new_session = ChatSession {
        id: new_session_id.clone(),
        mode: snapshot.session.mode.clone(),
        title: snapshot.session.title.map(|t| format!("{} (imported)", t)),
        description: snapshot.session.description.clone(),
        summary_hash: snapshot.session.summary_hash.clone(),
        // 导入标题视为用户资产的原始标题，锁定避免被自动摘要覆盖
        title_locked: true,
        persist_status: PersistStatus::Active,
        created_at: snapshot.session.created_at,
        updated_at: now,
        metadata: Some(metadata),
        // 分组/标签不随快照迁移（目标库可能没有对应分组）
        group_id: None,
        tags_hash: None,
        tags: None,
    };

    // 4. 消息重映射（模式同 branch_session_in_db）
    let mut new_messages: Vec<ChatMessage> = Vec::with_capacity(snapshot.messages.len());
    for msg in &snapshot.messages {
        let new_msg_id = msg_id_map.get(&msg.id).unwrap().clone();

        let new_block_ids: Vec<String> = msg
            .block_ids
            .iter()
            .map(|bid| {
                block_id_map
                    .get(bid)
                    .cloned()
                    .unwrap_or_else(|| bid.clone())
            })
            .collect();

        let new_parent_id = msg
            .parent_id
            .as_ref()
            .and_then(|pid| msg_id_map.get(pid).cloned());
        let new_supersedes = msg
            .supersedes
            .as_ref()
            .and_then(|sid| msg_id_map.get(sid).cloned());

        // 变体（多模型结果）：Variant.id 与 block_ids 一并重映射
        let new_variants = msg.variants.as_ref().map(|variants| {
            variants
                .iter()
                .map(|v| {
                    let new_var_block_ids: Vec<String> = v
                        .block_ids
                        .iter()
                        .map(|bid| {
                            block_id_map
                                .get(bid)
                                .cloned()
                                .unwrap_or_else(|| bid.clone())
                        })
                        .collect();
                    Variant {
                        id: Variant::generate_id(),
                        model_id: v.model_id.clone(),
                        config_id: v.config_id.clone(),
                        block_ids: new_var_block_ids,
                        status: v.status.clone(),
                        error: v.error.clone(),
                        created_at: v.created_at,
                        usage: v.usage.clone(),
                        meta: v.meta.clone(),
                    }
                })
                .collect::<Vec<_>>()
        });

        let new_active_variant_id =
            if let (Some(ref old_active), Some(ref old_variants), Some(ref new_vars)) =
                (&msg.active_variant_id, &msg.variants, &new_variants)
            {
                old_variants
                    .iter()
                    .position(|v| &v.id == old_active)
                    .and_then(|idx| new_vars.get(idx))
                    .map(|v| v.id.clone())
            } else {
                None
            };

        let new_shared_context = msg.shared_context.as_ref().map(|sc| {
            let remap = |bid: &Option<String>| -> Option<String> {
                bid.as_ref().and_then(|b| block_id_map.get(b).cloned())
            };
            SharedContext {
                rag_sources: sc.rag_sources.clone(),
                memory_sources: sc.memory_sources.clone(),
                graph_sources: sc.graph_sources.clone(),
                web_search_sources: sc.web_search_sources.clone(),
                multimodal_sources: sc.multimodal_sources.clone(),
                rag_block_id: remap(&sc.rag_block_id),
                memory_block_id: remap(&sc.memory_block_id),
                graph_block_id: remap(&sc.graph_block_id),
                web_search_block_id: remap(&sc.web_search_block_id),
                multimodal_block_id: remap(&sc.multimodal_block_id),
            }
        });

        new_messages.push(ChatMessage {
            id: new_msg_id,
            session_id: new_session_id.clone(),
            role: msg.role.clone(),
            block_ids: new_block_ids,
            timestamp: msg.timestamp,
            persistent_stable_id: msg.persistent_stable_id.clone(),
            parent_id: new_parent_id,
            supersedes: new_supersedes,
            meta: msg.meta.clone(),
            attachments: msg.attachments.clone(),
            active_variant_id: new_active_variant_id,
            variants: new_variants,
            shared_context: new_shared_context,
        });
    }

    // 5. 块重映射（tool_input/output 内的嵌套 ID 引用也重写）
    let combined_id_map: HashMap<String, String> = msg_id_map
        .iter()
        .chain(block_id_map.iter())
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    let mut new_blocks: Vec<MessageBlock> = Vec::with_capacity(valid_blocks.len());
    for source_block in &valid_blocks {
        let new_tool_input = source_block.tool_input.as_ref().map(|v| {
            let mut cloned = v.clone();
            remap_ids_in_value(&mut cloned, &combined_id_map);
            cloned
        });
        let new_tool_output = source_block.tool_output.as_ref().map(|v| {
            let mut cloned = v.clone();
            remap_ids_in_value(&mut cloned, &combined_id_map);
            cloned
        });

        new_blocks.push(MessageBlock {
            id: block_id_map.get(&source_block.id).unwrap().clone(),
            message_id: msg_id_map.get(&source_block.message_id).unwrap().clone(),
            block_type: source_block.block_type.clone(),
            status: source_block.status.clone(),
            content: source_block.content.clone(),
            tool_name: source_block.tool_name.clone(),
            tool_input: new_tool_input,
            tool_output: new_tool_output,
            citations: source_block.citations.clone(),
            error: source_block.error.clone(),
            started_at: source_block.started_at,
            ended_at: source_block.ended_at,
            first_chunk_at: source_block.first_chunk_at,
            block_index: source_block.block_index,
        });
    }

    // 6. 会话状态：裁剪草稿字段（同 branch）
    let new_session_state = snapshot.session_state.as_ref().map(|state| SessionState {
        session_id: new_session_id.clone(),
        chat_params: state.chat_params.clone(),
        features: state.features.clone(),
        mode_state: state.mode_state.clone(),
        input_value: None,
        panel_states: None,
        updated_at: now.to_rfc3339(),
        pending_context_refs_json: None,
        loaded_skill_ids_json: state.loaded_skill_ids_json.clone(),
        active_skill_ids_json: state.active_skill_ids_json.clone(),
        skill_state_json: state.skill_state_json.clone(),
    });

    // 7. 资源引用提示（v1 不做 ref_count 增量 — 目标库可能没有对应 VFS 资源）
    let has_resource_refs = new_messages.iter().any(|m| {
        m.meta
            .as_ref()
            .and_then(|meta| meta.context_snapshot.as_ref())
            .map(|cs| !cs.all_resource_ids().is_empty())
            .unwrap_or(false)
    });
    if has_resource_refs {
        warnings.push(
            "Snapshot references VFS resources; they may not exist locally and are not relinked"
                .to_string(),
        );
    }

    // 8. 事务写入：session → messages → blocks → session_state
    let mut conn = db.get_conn_safe().map_err(|e| e.to_string())?;
    let tx = conn
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;

    ChatV2Repo::create_session_with_conn(&tx, &new_session).map_err(|e| e.to_string())?;

    let message_count = new_messages.len();
    for msg in &new_messages {
        ChatV2Repo::create_message_with_conn(&tx, msg).map_err(|e| e.to_string())?;
    }

    let block_count = new_blocks.len();
    for block in &new_blocks {
        ChatV2Repo::create_block_with_conn(&tx, block).map_err(|e| e.to_string())?;
    }

    if let Some(ref state) = new_session_state {
        ChatV2Repo::save_session_state_with_conn(&tx, &new_session_id, state)
            .map_err(|e| e.to_string())?;
    }

    tx.commit()
        .map_err(|e| format!("Failed to commit import transaction: {}", e))?;

    log::info!(
        "[ChatV2::handlers] Import committed: session={}, {} messages, {} blocks, {} warnings",
        new_session_id,
        message_count,
        block_count,
        warnings.len()
    );

    Ok(ImportSessionResult {
        session_id: new_session_id,
        message_count,
        block_count,
        warnings,
    })
}
