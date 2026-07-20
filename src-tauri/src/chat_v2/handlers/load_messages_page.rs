//! 会话消息分页加载命令处理器
//!
//! 移动端 / 长会话场景下，首屏由 `chat_v2_load_session(tail_limit)` 取尾部窗口，
//! 更早的历史通过本命令按 offset/limit 窗口渐进补齐，避免一次性全量拉取
//! 造成的 IPC 大载荷与主线程长任务。

use std::sync::Arc;

use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::LoadMessagesPageResponse;

/// 默认页大小（与 TauriAdapter 补页批量对齐）
const DEFAULT_PAGE_LIMIT: u32 = 100;
/// 页大小上限（防止前端误传超大 limit 退化回全量加载）
const MAX_PAGE_LIMIT: u32 = 500;

/// 分页加载会话消息（offset-based）
///
/// ## 参数
/// - `session_id`: 会话 ID（`sess_` / `agent_` / `subagent_` 前缀）
/// - `offset`: 按时间正序的行偏移，缺省 0
/// - `limit`: 页大小，缺省 100，clamp 到 [1, 500]
///
/// ## 返回
/// `LoadMessagesPageResponse { messages, blocks, totalMessageCount, offset, limit }`
/// 其中 messages/blocks 与 `chat_v2_load_session` 的序列化结构一致，
/// 可直接喂给前端既有的恢复/合并逻辑。
#[tauri::command]
pub async fn chat_v2_load_messages_page(
    session_id: String,
    offset: Option<u32>,
    limit: Option<u32>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<LoadMessagesPageResponse, String> {
    // 与 chat_v2_load_session 保持一致的会话 ID 校验
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }

    let offset = offset.unwrap_or(0);
    let limit = limit.unwrap_or(DEFAULT_PAGE_LIMIT).clamp(1, MAX_PAGE_LIMIT);

    let conn = db.get_conn_safe().map_err(String::from)?;
    let (messages, blocks, total) = ChatV2Repo::load_session_messages_window_with_conn(
        &conn,
        &session_id,
        u64::from(offset),
        limit,
        None,
    )
    .map_err(String::from)?;

    log::debug!(
        "[ChatV2::handlers] chat_v2_load_messages_page: session_id={}, offset={}, limit={}, messages={}, blocks={}, total={}",
        session_id,
        offset,
        limit,
        messages.len(),
        blocks.len(),
        total
    );

    Ok(LoadMessagesPageResponse {
        messages,
        blocks,
        total_message_count: total,
        offset,
        limit,
    })
}
