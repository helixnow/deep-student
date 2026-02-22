//! 内置附件工具执行器
//!
//! 解决 P0 断裂点：用户上传的附件无法通过工具主动读取
//!
//! 执行两个内置附件工具：
//! - `builtin-attachment_list` - 列出会话中的附件
//! - `builtin-attachment_read` - 读取指定附件内容
//!
//! ## 设计说明
//! 该执行器通过 ChatDatabase 访问历史消息中的附件，
//! 为 LLM 提供主动读取用户上传附件的能力。

use std::collections::HashSet;
use std::time::Instant;

use async_trait::async_trait;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::resource_types::ContextRef;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::document_parser::DocumentParser;

// ============================================================================
// 常量
// ============================================================================

/// 默认列表数量
const DEFAULT_LIST_LIMIT: u32 = 20;

// ============================================================================
// 内置附件工具执行器
// ============================================================================

/// 内置附件工具执行器
///
/// 处理以 `builtin-` 开头的附件工具：
/// - `builtin-attachment_list` - 列出会话附件
/// - `builtin-attachment_read` - 读取附件内容
pub struct AttachmentToolExecutor;

impl AttachmentToolExecutor {
    /// 创建新的附件工具执行器
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        super::strip_tool_namespace(tool_name)
    }

    /// 执行附件列表
    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let main_db = ctx.main_db.as_ref().ok_or("Main database not available")?;

        // P0-01 安全修复：验证 session_id 参数，防止跨会话访问
        if let Some(param_session_id) = call.arguments.get("session_id").and_then(|v| v.as_str()) {
            if param_session_id != ctx.session_id {
                log::warn!(
                    "[AttachmentToolExecutor] Ignore mismatched session_id parameter: expected={}, got={}",
                    ctx.session_id,
                    param_session_id
                );
            }
        }

        // 解析参数（始终使用当前会话 ID）
        let session_id = ctx.session_id.clone();
        let type_filter = call
            .arguments
            .get("type")
            .and_then(|v| v.as_str())
            .unwrap_or("all");
        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_LIST_LIMIT as u64) as u32;

        log::debug!(
            "[AttachmentToolExecutor] attachment_list: session_id={}, type={}, limit={}",
            session_id,
            type_filter,
            limit
        );

        let start_time = Instant::now();

        // 查询会话中的消息
        let messages = ChatV2Repo::get_session_messages(main_db, &session_id)
            .map_err(|e| format!("Failed to get messages: {}", e))?;

        // 收集所有附件（兼容 legacy attachments + context_snapshot.user_refs）
        let mut attachments: Vec<Value> = Vec::new();
        let mut seen_keys: HashSet<String> = HashSet::new();
        for message in &messages {
            if let Some(ref atts) = message.attachments {
                for att in atts {
                    // 类型过滤
                    if type_filter != "all" && att.r#type != type_filter {
                        continue;
                    }

                    let dedupe_key = format!("{}::{}", message.id, att.id);
                    if !seen_keys.insert(dedupe_key) {
                        continue;
                    }

                    attachments.push(json!({
                        "attachment_id": att.id,
                        "message_id": message.id,
                        "name": att.name,
                        "type": att.r#type,
                        "mime_type": att.mime_type,
                        "size": att.size,
                        "status": att.status,
                        "timestamp": message.timestamp,
                    }));

                    if attachments.len() >= limit as usize {
                        break;
                    }
                }
            }

            if let Some(meta) = &message.meta {
                if let Some(snapshot) = &meta.context_snapshot {
                    for context_ref in &snapshot.user_refs {
                        if !matches!(context_ref.type_id.as_str(), "file" | "image" | "folder") {
                            continue;
                        }

                        let mapped_type = map_context_ref_to_attachment_type(&context_ref.type_id);
                        if type_filter != "all" && mapped_type != type_filter {
                            continue;
                        }

                        let dedupe_key = format!("{}::{}", message.id, context_ref.resource_id);
                        if !seen_keys.insert(dedupe_key) {
                            continue;
                        }

                        attachments.push(json!({
                            "attachment_id": context_ref.resource_id,
                            "message_id": message.id,
                            "name": context_ref.display_name.clone().unwrap_or_else(|| context_ref.resource_id.clone()),
                            "type": mapped_type,
                            "mime_type": map_context_ref_to_mime(&context_ref.type_id),
                            "size": Value::Null,
                            "status": "context_ref",
                            "timestamp": message.timestamp,
                            "source": "context_snapshot",
                        }));

                        if attachments.len() >= limit as usize {
                            break;
                        }
                    }
                }
            }

            if attachments.len() >= limit as usize {
                break;
            }
        }

        let duration = start_time.elapsed().as_millis() as u64;

        log::debug!(
            "[AttachmentToolExecutor] attachment_list completed: {} attachments in {}ms",
            attachments.len(),
            duration
        );

        Ok(json!({
            "success": true,
            "session_id": session_id,
            "attachments": attachments,
            "count": attachments.len(),
            "durationMs": duration,
        }))
    }

    /// 执行附件读取
    async fn execute_read(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let main_db = ctx.main_db.as_ref().ok_or("Main database not available")?;

        // 解析参数
        let message_id = call
            .arguments
            .get("message_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'message_id' parameter")?;
        let attachment_id = call
            .arguments
            .get("attachment_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'attachment_id' parameter")?;
        let parse_content = call
            .arguments
            .get("parse_content")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        log::debug!(
            "[AttachmentToolExecutor] attachment_read: message_id={}, attachment_id={}, parse_content={}",
            message_id, attachment_id, parse_content
        );

        let start_time = Instant::now();

        // 获取消息
        let message = ChatV2Repo::get_message(main_db, message_id)
            .map_err(|e| format!("Failed to get message: {}", e))?
            .ok_or_else(|| format!("Message not found: {}", message_id))?;

        // P0-01 安全修复：验证消息所属会话，防止跨会话访问
        if message.session_id != ctx.session_id {
            return Err("Unauthorized: Cannot access attachments from other sessions".to_string());
        }

        if let Some(attachment) = message
            .attachments
            .as_ref()
            .and_then(|atts| atts.iter().find(|a| a.id == attachment_id))
        {
            // 从 preview_url 提取内容
            let content = if let Some(preview_url) = &attachment.preview_url {
                if preview_url.starts_with("data:") {
                    // 解析 data URL: data:mime_type;base64,content
                    let parts: Vec<&str> = preview_url.splitn(2, ",").collect();
                    if parts.len() == 2 {
                        let base64_content = parts[1];

                        // 判断是否为文本类型
                        let is_text_type = attachment.mime_type.starts_with("text/")
                            || attachment.mime_type == "application/json"
                            || attachment.mime_type == "application/xml"
                            || attachment.mime_type == "application/javascript";

                        if is_text_type {
                            // 文本类型：base64 解码
                            use base64::Engine;
                            let decoded = base64::engine::general_purpose::STANDARD
                                .decode(base64_content)
                                .map_err(|e| format!("Failed to decode base64: {}", e))?;
                            String::from_utf8(decoded)
                                .map_err(|e| format!("Invalid UTF-8: {}", e))?
                        } else if attachment.r#type == "image" {
                            // 图片类型：返回 base64（让多模态模型处理）
                            base64_content.to_string()
                        } else if parse_content {
                            // 文档类型：尝试使用 DocumentParser 解析
                            let parser = DocumentParser::new();
                            match parser.extract_text_from_base64(&attachment.name, base64_content)
                            {
                                Ok(text) => text,
                                Err(e) => {
                                    log::warn!(
                                        "[AttachmentToolExecutor] Failed to parse document {}: {}",
                                        attachment.name,
                                        e
                                    );
                                    format!("[文档: {}] (解析失败: {})", attachment.name, e)
                                }
                            }
                        } else {
                            // 不解析，返回原始 base64
                            base64_content.to_string()
                        }
                    } else {
                        return Err("Invalid data URL format".to_string());
                    }
                } else {
                    return Err("Attachment content not available (no data URL)".to_string());
                }
            } else {
                return Err("Attachment has no preview_url".to_string());
            };

            let duration = start_time.elapsed().as_millis() as u64;

            log::debug!(
                "[AttachmentToolExecutor] attachment_read completed: id={}, content_len={}, {}ms",
                attachment_id,
                content.len(),
                duration
            );

            return Ok(json!({
                "success": true,
                "attachment_id": attachment_id,
                "message_id": message_id,
                "name": attachment.name,
                "type": attachment.r#type,
                "mime_type": attachment.mime_type,
                "content": content,
                "contentLength": content.len(),
                "durationMs": duration,
            }));
        }

        // 统一引用模式兼容：支持读取 context_snapshot.user_refs 中的 file_/tb_/att_
        let context_ref = message
            .meta
            .as_ref()
            .and_then(|meta| meta.context_snapshot.as_ref())
            .and_then(|snapshot| {
                snapshot
                    .user_refs
                    .iter()
                    .find(|r| r.resource_id == attachment_id)
            })
            .ok_or_else(|| {
                format!(
                    "Attachment not found: {} in message {}",
                    attachment_id, message_id
                )
            })?;

        let (name, mime_type, content) = read_context_ref_content(ctx, context_ref, parse_content)?;
        let duration = start_time.elapsed().as_millis() as u64;

        Ok(json!({
            "success": true,
            "attachment_id": attachment_id,
            "message_id": message_id,
            "name": name,
            "type": map_context_ref_to_attachment_type(&context_ref.type_id),
            "mime_type": mime_type,
            "content": content,
            "contentLength": content.len(),
            "source": "context_snapshot",
            "durationMs": duration,
        }))
    }
}

fn map_context_ref_to_attachment_type(type_id: &str) -> &'static str {
    match type_id {
        "image" => "image",
        _ => "document",
    }
}

fn map_context_ref_to_mime(type_id: &str) -> &'static str {
    match type_id {
        "image" => "image/*",
        "folder" => "inode/directory",
        _ => "application/octet-stream",
    }
}

fn read_context_ref_content(
    ctx: &ExecutionContext,
    context_ref: &ContextRef,
    parse_content: bool,
) -> Result<(String, String, String), String> {
    let vfs_db = ctx
        .vfs_db
        .as_ref()
        .ok_or("VFS database not available for context ref read")?;
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;

    if context_ref.resource_id.starts_with("fld_") {
        return Err("Folder context reference is not readable via attachment_read".to_string());
    }

    let row = conn
        .query_row(
            r#"
            SELECT COALESCE(f.file_name, f.id) AS name, COALESCE(f.mime_type, ''), COALESCE(r.content, '')
            FROM files f
            LEFT JOIN resources r ON f.resource_id = r.id
            WHERE f.id = ?1
              AND f.deleted_at IS NULL
              AND (r.deleted_at IS NULL OR r.id IS NULL)
            "#,
            rusqlite::params![context_ref.resource_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let (name, mime_type, raw_content) =
        row.ok_or_else(|| format!("Resource not found in VFS: {}", context_ref.resource_id))?;

    let is_image_ref = context_ref.type_id == "image" || mime_type.starts_with("image/");
    if is_image_ref && !parse_content {
        return Ok((name, mime_type, raw_content));
    }

    if is_image_ref && raw_content.starts_with("data:") {
        let base64_content = raw_content
            .split_once(',')
            .map(|(_, right)| right.to_string())
            .unwrap_or_default();
        return Ok((name, mime_type, base64_content));
    }

    Ok((name, mime_type, raw_content))
}

impl Default for AttachmentToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for AttachmentToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(stripped, "attachment_list" | "attachment_read")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        log::debug!(
            "[AttachmentToolExecutor] Executing builtin tool: {} (full: {})",
            tool_name,
            call.name
        );

        // 发射工具调用开始事件
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let result = match tool_name {
            "attachment_list" => self.execute_list(call, ctx).await,
            "attachment_read" => self.execute_read(call, ctx).await,
            _ => Err(format!("Unknown attachment tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                // 发射工具调用结束事件
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration,
                    })),
                    None,
                );

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                // SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AttachmentToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                // 发射工具调用错误事件
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration,
                );

                // SSOT: 后端立即保存工具块（防闪退）
                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[AttachmentToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 附件工具是只读操作，低敏感
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "AttachmentToolExecutor"
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = AttachmentToolExecutor::new();

        // 处理附件工具
        assert!(executor.can_handle("builtin-attachment_list"));
        assert!(executor.can_handle("builtin-attachment_read"));

        // 不处理其他 builtin 工具
        assert!(!executor.can_handle("builtin-rag_search"));
        assert!(!executor.can_handle("builtin-resource_read"));
    }

    #[test]
    fn test_strip_namespace() {
        assert_eq!(
            AttachmentToolExecutor::strip_namespace("builtin-attachment_list"),
            "attachment_list"
        );
        assert_eq!(
            AttachmentToolExecutor::strip_namespace("attachment_read"),
            "attachment_read"
        );
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = AttachmentToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-attachment_list"),
            ToolSensitivity::Low
        );
    }
}
