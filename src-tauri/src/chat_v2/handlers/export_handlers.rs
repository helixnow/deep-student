//! 会话导出命令处理器
//!
//! 将会话（元信息 + 消息 + 块）导出为 Markdown 或 JSON，作为产品级一等能力。
//! 直接从 repo 读取并在此拼装，不依赖 tools/session_executor 的内部实现。

use std::collections::HashMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::chat_v2::database::ChatV2Database;
use crate::chat_v2::error::ChatV2Error;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::session_export::{
    export_session_jsonl, SessionExportOptions, SessionExportSummary,
};
use crate::chat_v2::types::{block_types, ChatMessage, MessageBlock, MessageRole};

/// 会话 ID 前缀校验（sess_ / agent_ / subagent_），导出命令共用。
fn validate_session_id(session_id: &str) -> Result<(), String> {
    if !session_id.starts_with("sess_")
        && !session_id.starts_with("agent_")
        && !session_id.starts_with("subagent_")
    {
        return Err(
            ChatV2Error::Validation(format!("Invalid session ID format: {}", session_id)).into(),
        );
    }
    Ok(())
}

/// 导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSessionResponse {
    /// 会话 ID
    pub session_id: String,
    /// 实际使用的导出格式（"markdown" | "json"）
    pub format: String,
    /// 导出内容（Markdown 文本或 JSON 字符串）
    pub content: String,
    /// 导出的消息数
    pub message_count: u32,
}

/// 导出会话为 Markdown 或 JSON
///
/// ## 参数
/// - `session_id`: 会话 ID（`sess_` / `agent_` / `subagent_` 前缀）
/// - `format`: `"markdown"`（默认）或 `"json"`
/// - `include_thinking`: Markdown 格式下是否包含 thinking 块（默认 false；JSON 恒为全量）
///
/// ## 返回
/// - `Ok(ExportSessionResponse)`: 导出内容
/// - `Err(String)`: 会话不存在或导出失败
#[tauri::command]
pub async fn chat_v2_export_session(
    session_id: String,
    format: Option<String>,
    include_thinking: Option<bool>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<ExportSessionResponse, String> {
    validate_session_id(&session_id)?;

    let format = format.unwrap_or_else(|| "markdown".to_string());
    if format != "markdown" && format != "json" {
        return Err(ChatV2Error::Validation(format!(
            "Invalid export format '{}'. Valid formats: markdown, json",
            format
        ))
        .into());
    }

    let session = ChatV2Repo::get_session_v2(&db, &session_id)
        .map_err(String::from)?
        .ok_or_else(|| String::from(ChatV2Error::SessionNotFound(session_id.clone())))?;
    let messages = ChatV2Repo::get_session_messages_v2(&db, &session_id).map_err(String::from)?;
    let blocks = ChatV2Repo::get_session_blocks_v2(&db, &session_id).map_err(String::from)?;

    let message_count = messages.len() as u32;
    let content = match format.as_str() {
        "json" => {
            let payload = serde_json::json!({
                "session": session,
                "messages": messages,
                "blocks": blocks,
                "exportedAt": chrono::Utc::now().to_rfc3339(),
            });
            serde_json::to_string_pretty(&payload)
                .map_err(|e| String::from(ChatV2Error::Serialization(e.to_string())))?
        }
        _ => render_markdown(
            &session,
            &messages,
            &blocks,
            include_thinking.unwrap_or(false),
        ),
    };

    log::info!(
        "[ChatV2::handlers] chat_v2_export_session: session_id={}, format={}, messages={}, bytes={}",
        session_id,
        format,
        message_count,
        content.len()
    );

    Ok(ExportSessionResponse {
        session_id,
        format,
        content,
        message_count,
    })
}

/// 将会话按 WI-12 JSONL 规范流式导出到目标文件
///
/// 格式规范见 `docs/dev/optimization0824/WI-12-session-jsonl-spec.md`；
/// 实现为 `chat_v2::session_export::export_session_jsonl`（逐行流式写出，
/// 默认脱敏 `redactSecrets=true`）。
///
/// ## 参数
/// - `session_id`: 会话 ID（`sess_` / `agent_` / `subagent_` 前缀）
/// - `target_path`: 目标文件绝对路径（须以 `.jsonl` 结尾，由前端保存对话框提供）
/// - `options`: 导出参数（省略字段取默认值：全变体 + 状态 + 压缩记录 + 脱敏）
///
/// ## 返回
/// - `Ok(SessionExportSummary)`: 与 footer 行一致的计数摘要
/// - `Err(String)`: 会话不存在 / 参数非法 / IO 失败（结构化 code+message JSON）
#[tauri::command]
pub async fn chat_v2_export_session_jsonl(
    session_id: String,
    target_path: String,
    options: Option<SessionExportOptions>,
    db: State<'_, Arc<ChatV2Database>>,
) -> Result<SessionExportSummary, String> {
    validate_session_id(&session_id)?;

    if !target_path.to_lowercase().ends_with(".jsonl") {
        return Err(ChatV2Error::Validation(format!(
            "Invalid export path '{}': expected a .jsonl file",
            target_path
        ))
        .into());
    }

    let options = options.unwrap_or_default();
    let file = std::fs::File::create(&target_path)
        .map_err(|e| String::from(ChatV2Error::IoError(format!("{}: {}", target_path, e))))?;
    let mut writer = std::io::BufWriter::new(file);

    let summary =
        export_session_jsonl(&db, &session_id, &options, &mut writer).map_err(String::from)?;

    log::info!(
        "[ChatV2::handlers] chat_v2_export_session_jsonl: session_id={}, messages={}, blocks={}, compactions={}, bytes={}, path={}",
        session_id,
        summary.message_count,
        summary.block_count,
        summary.compaction_count,
        summary.bytes_written,
        target_path
    );

    Ok(summary)
}

/// 消息在导出时的有效块 ID 列表：
/// 有激活变体时导出该变体的块，否则导出消息主干块（与前端渲染一致）。
fn effective_block_ids(message: &ChatMessage) -> Vec<String> {
    if let (Some(active_id), Some(variants)) = (
        message.active_variant_id.as_deref(),
        message.variants.as_ref(),
    ) {
        if let Some(variant) = variants.iter().find(|v| v.id == active_id) {
            return variant.block_ids.clone();
        }
    }
    message.block_ids.clone()
}

fn render_markdown(
    session: &crate::chat_v2::types::ChatSession,
    messages: &[ChatMessage],
    blocks: &[MessageBlock],
    include_thinking: bool,
) -> String {
    let block_map: HashMap<&str, &MessageBlock> =
        blocks.iter().map(|b| (b.id.as_str(), b)).collect();

    let mut out = String::new();
    let title = session.title.as_deref().unwrap_or("Untitled Session");
    out.push_str(&format!("# {}\n\n", title));
    if let Some(description) = session.description.as_deref() {
        if !description.trim().is_empty() {
            out.push_str(&format!("> {}\n\n", description.trim()));
        }
    }
    out.push_str(&format!(
        "- Session: `{}`\n- Mode: {}\n- Created: {}\n- Updated: {}\n- Exported: {}\n\n---\n",
        session.id,
        session.mode,
        session.created_at.to_rfc3339(),
        session.updated_at.to_rfc3339(),
        chrono::Utc::now().to_rfc3339()
    ));

    for message in messages {
        let role_label = match message.role {
            MessageRole::User => "User",
            MessageRole::Assistant => "Assistant",
        };
        out.push_str(&format!("\n## {}\n\n", role_label));

        for block_id in effective_block_ids(message) {
            let Some(block) = block_map.get(block_id.as_str()) else {
                continue;
            };
            match block.block_type.as_str() {
                block_types::CONTENT => {
                    if let Some(content) = block.content.as_deref() {
                        if !content.trim().is_empty() {
                            out.push_str(content.trim_end());
                            out.push_str("\n\n");
                        }
                    }
                }
                block_types::THINKING => {
                    if include_thinking {
                        if let Some(content) = block.content.as_deref() {
                            if !content.trim().is_empty() {
                                out.push_str("<details><summary>Thinking</summary>\n\n");
                                out.push_str(content.trim_end());
                                out.push_str("\n\n</details>\n\n");
                            }
                        }
                    }
                }
                other => {
                    // 工具/检索等块导出为紧凑摘要，避免超大 JSON 淹没正文
                    let tool_label = block
                        .tool_name
                        .as_deref()
                        .map(|name| format!("{} ({})", other, name))
                        .unwrap_or_else(|| other.to_string());
                    out.push_str(&format!("*[{}: {}]*\n\n", tool_label, block.status));
                    if let Some(error) = block.error.as_deref() {
                        if !error.trim().is_empty() {
                            out.push_str(&format!("> Error: {}\n\n", error.trim()));
                        }
                    }
                }
            }
        }
    }

    out
}
