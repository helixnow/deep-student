use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::llm_manager::LLMManager;
use crate::memory::{MemoryService, WriteMode};
use crate::vfs::lance_store::VfsLanceStore;

pub const MEMORY_SEARCH: &str = "builtin-memory_search";
pub const MEMORY_READ: &str = "builtin-memory_read";
pub const MEMORY_WRITE: &str = "builtin-memory_write";
pub const MEMORY_LIST: &str = "builtin-memory_list";
pub const MEMORY_UPDATE_BY_ID: &str = "builtin-memory_update_by_id";
pub const MEMORY_DELETE: &str = "builtin-memory_delete";
pub const MEMORY_WRITE_SMART: &str = "builtin-memory_write_smart";

pub struct MemoryToolExecutor;

impl MemoryToolExecutor {
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

    /// 检查工具名是否为 Memory 工具
    fn is_memory_tool(tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(
            stripped,
            "memory_search"
                | "memory_read"
                | "memory_write"
                | "memory_list"
                | "memory_update_by_id"
                | "memory_delete"
                | "memory_write_smart"
        )
    }

    fn needs_root_bootstrap(root_folder_id: Option<&str>) -> bool {
        root_folder_id.is_none()
    }

    fn get_service(&self, ctx: &ExecutionContext) -> Result<MemoryService, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?;

        let lance_store = ctx
            .vfs_lance_store
            .clone()
            .map(Ok)
            .unwrap_or_else(|| VfsLanceStore::new(vfs_db.clone()).map(Arc::new))
            .map_err(|e| format!("Failed to create lance store: {}", e))?;

        Ok(MemoryService::new(
            vfs_db.clone(),
            lance_store,
            llm_manager.clone(),
        ))
    }

    fn ensure_root_configured(&self, service: &MemoryService) -> Result<(), Value> {
        let config = service.get_config().map_err(|e| {
            json!({
                "error": "记忆功能配置读取失败",
                "details": e.to_string()
            })
        })?;

        if Self::needs_root_bootstrap(config.memory_root_folder_id.as_deref()) {
            let folder_id = service.get_or_create_root_folder().map_err(|e| {
                json!({
                    "error": "记忆根文件夹初始化失败",
                    "hint": "请前往「学习资源中心 > 记忆管理」手动设置记忆根文件夹，或前往数据治理进行修复",
                    "details": e.to_string(),
                    "action_required": true
                })
            })?;
            log::info!(
                "[MemoryToolExecutor] Auto-created memory root folder for first use: {}",
                folder_id
            );
        }
        Ok(())
    }

    async fn execute_search(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory search cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let query = call
            .arguments
            .get("query")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'query' parameter")?;

        let top_k = call
            .arguments
            .get("top_k")
            .and_then(|v| v.as_u64())
            .map(|v| v as usize)
            .unwrap_or(5);

        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        let results = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.search(query, top_k) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory search cancelled");
                    return Err("Memory search cancelled during execution".to_string());
                }
            }
        } else {
            service
                .search(query, top_k)
                .await
                .map_err(|e| e.to_string())?
        };

        // 兼容检索块与来源面板：输出统一的 sources 结构，
        // 同时保留 results 字段给旧调用方。
        let sources: Vec<Value> = results
            .iter()
            .map(|item| {
                json!({
                    "title": item.note_title,
                    "snippet": item.chunk_text,
                    "score": item.score,
                    "metadata": {
                        "document_id": item.note_id,
                        "memory_id": item.note_id,
                        "note_id": item.note_id,
                        "folder_path": item.folder_path,
                        "source_type": "memory"
                    }
                })
            })
            .collect();

        Ok(json!({
            "sources": sources,
            "results": results,
            "count": results.len()
        }))
    }

    async fn execute_read(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory read cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?;

        let note_id_owned = note_id.to_string();

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let read_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || service.read(&note_id_owned))
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = read_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory read cancelled");
                    return Err("Memory read cancelled during execution".to_string());
                }
            }
        } else {
            read_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };

        match result {
            Some((note, content)) => Ok(json!({
                "found": true,
                "note_id": note.id,
                "title": note.title,
                "content": content,
                "updated_at": note.updated_at
            })),
            None => Ok(json!({
                "found": false,
                "note_id": note_id
            })),
        }
    }

    async fn execute_write(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory write cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let folder = call
            .arguments
            .get("folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let mode_str = call
            .arguments
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or(if note_id.is_some() {
                "update"
            } else {
                "create"
            });

        let mode = WriteMode::from_str(mode_str);

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let write_task = {
            let service = service.clone();
            let note_id = note_id.clone();
            let title = title.clone();
            let content = content.clone();
            let folder = folder.clone();
            tokio::task::spawn_blocking(move || -> Result<_, String> {
                if let Some(ref note_id) = note_id {
                    match mode {
                        WriteMode::Append => {
                            let current = service
                                .read(note_id)
                                .map_err(|e| e.to_string())?
                                .map(|(_, c)| c)
                                .unwrap_or_default();
                            let append_content =
                                content.as_ref().ok_or("Missing 'content' parameter")?;
                            let final_content = format!("{}\n\n{}", current, append_content);
                            service
                                .update_by_id(note_id, title.as_deref(), Some(&final_content))
                                .map_err(|e| e.to_string())
                        }
                        _ => {
                            if title.is_none() && content.is_none() {
                                return Err("Missing 'title' or 'content' parameter".to_string());
                            }
                            service
                                .update_by_id(note_id, title.as_deref(), content.as_deref())
                                .map_err(|e| e.to_string())
                        }
                    }
                } else {
                    let title = title.as_ref().ok_or("Missing 'title' parameter")?;
                    let content = content.as_ref().ok_or("Missing 'content' parameter")?;
                    service
                        .write(folder.as_deref(), title, content, mode)
                        .map_err(|e| e.to_string())
                }
            })
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = write_task => res.map_err(|e| e.to_string())??,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory write cancelled");
                    return Err("Memory write cancelled during execution".to_string());
                }
            }
        } else {
            write_task.await.map_err(|e| e.to_string())??
        };

        Ok(json!({
            "success": true,
            "note_id": result.note_id,
            "is_new": result.is_new
        }))
    }

    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory list cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let folder = call
            .arguments
            .get("folder")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let limit = call
            .arguments
            .get("limit")
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
            .unwrap_or(100);

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let list_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || service.list(folder.as_deref(), limit, 0))
        };

        let items = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = list_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory list cancelled");
                    return Err("Memory list cancelled during execution".to_string());
                }
            }
        } else {
            list_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };

        Ok(json!({
            "items": items,
            "count": items.len()
        }))
    }

    async fn execute_update_by_id(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory update cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?
            .to_string();
        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if title.is_none() && content.is_none() {
            return Err("Missing 'title' or 'content' parameter".to_string());
        }

        // 🆕 取消支持：使用 spawn_blocking + tokio::select! 监听取消信号
        let update_task = {
            let service = service.clone();
            tokio::task::spawn_blocking(move || {
                service.update_by_id(&note_id, title.as_deref(), content.as_deref())
            })
        };

        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = update_task => res.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory update cancelled");
                    return Err("Memory update cancelled during execution".to_string());
                }
            }
        } else {
            update_task
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?
        };

        Ok(json!({
            "success": true,
            "note_id": result.note_id,
            "is_new": result.is_new
        }))
    }

    async fn execute_delete(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory delete cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let note_id = call
            .arguments
            .get("note_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'note_id' parameter")?;

        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.delete(note_id) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory delete cancelled");
                    return Err("Memory delete cancelled during execution".to_string());
                }
            }
        } else {
            service.delete(note_id).await.map_err(|e| e.to_string())?
        };
        Ok(json!({ "success": true, "note_id": note_id }))
    }

    async fn execute_write_smart(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        // 🆕 取消检查：在执行前检查是否已取消
        if ctx.is_cancelled() {
            return Err("Memory write_smart cancelled before start".to_string());
        }

        let service = self.get_service(ctx)?;

        if let Err(hint) = self.ensure_root_configured(&service) {
            return Ok(hint);
        }

        let title = call
            .arguments
            .get("title")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'title' parameter")?;
        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'content' parameter")?;
        let folder = call.arguments.get("folder").and_then(|v| v.as_str());

        // 🆕 取消支持：使用 tokio::select! 监听取消信号
        let result = if let Some(cancel_token) = ctx.cancellation_token() {
            tokio::select! {
                res = service.write_smart(folder, title, content) => res.map_err(|e| e.to_string())?,
                _ = cancel_token.cancelled() => {
                    log::info!("[MemoryToolExecutor] Memory write_smart cancelled");
                    return Err("Memory write_smart cancelled during execution".to_string());
                }
            }
        } else {
            service
                .write_smart(folder, title, content)
                .await
                .map_err(|e| e.to_string())?
        };

        Ok(json!({
            "note_id": result.note_id,
            "event": result.event,
            "is_new": result.is_new,
            "confidence": result.confidence,
            "reason": result.reason
        }))
    }
}

#[async_trait]
impl ToolExecutor for MemoryToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_memory_tool(tool_name)
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();

        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let stripped_name = Self::strip_namespace(&call.name);

        let result = match stripped_name {
            "memory_search" => self.execute_search(call, ctx).await,
            "memory_read" => self.execute_read(call, ctx).await,
            "memory_write" => self.execute_write(call, ctx).await,
            "memory_list" => self.execute_list(call, ctx).await,
            "memory_update_by_id" => self.execute_update_by_id(call, ctx).await,
            "memory_delete" => self.execute_delete(call, ctx).await,
            "memory_write_smart" => self.execute_write_smart(call, ctx).await,
            _ => Err(format!("Unknown memory tool: {}", call.name)),
        };

        let duration_ms = start_time.elapsed().as_millis() as u32;

        match result {
            Ok(output) => {
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(json!({
                        "result": output,
                        "durationMs": duration_ms,
                    })),
                    None,
                );
                Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration_ms as u64,
                ))
            }
            Err(e) => {
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &e, None);
                Ok(ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    duration_ms as u64,
                ))
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = Self::strip_namespace(tool_name);
        match stripped {
            "memory_delete" => ToolSensitivity::Medium, // 删除操作需要更高敏感度
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "MemoryToolExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::MemoryToolExecutor;

    #[test]
    fn test_needs_root_bootstrap() {
        assert!(MemoryToolExecutor::needs_root_bootstrap(None));
        assert!(!MemoryToolExecutor::needs_root_bootstrap(Some("folder-1")));
    }
}
