//! DOCX 文档工具执行器
//!
//! 提供完整的 DOCX 读写编辑能力给 LLM：
//! - `builtin-docx_read_structured` - 结构化读取 DOCX（输出富 Markdown）
//! - `builtin-docx_extract_tables` - 提取 DOCX 中的表格为结构化 JSON
//! - `builtin-docx_get_metadata` - 读取文档属性
//! - `builtin-docx_create` - 从 JSON spec 生成 DOCX 文件并保存到 VFS
//! - `builtin-docx_to_spec` - 将 DOCX 转换为 JSON spec（round-trip 编辑）
//! - `builtin-docx_replace_text` - 在 DOCX 中执行查找替换并保存为新文件
//!
//! ## 设计说明
//! 后端使用 docx-rs crate 的完整读写 API，
//! 通过 VFS 系统读取/存储文件。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::document_parser::DocumentParser;

// ============================================================================
// DOCX 工具执行器
// ============================================================================

/// DOCX 文档工具执行器
pub struct DocxToolExecutor;

impl DocxToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    /// 结构化读取 DOCX（输出富 Markdown，保留标题/表格/列表/格式/链接/图片占位）
    async fn execute_read_structured(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;

        let bytes = self.load_docx_bytes(ctx, resource_id)?;

        // 文件大小安全检查（50MB 上限）
        if bytes.len() > 50 * 1024 * 1024 {
            return Err(format!(
                "DOCX 文件过大: {}MB (上限 50MB)",
                bytes.len() / 1024 / 1024
            ));
        }

        // spawn_blocking 防止同步解析阻塞 tokio 线程（与 PPTX/XLSX 对齐）
        let structured = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_docx_structured(&bytes)
        })
        .await
        .map_err(|e| format!("DOCX 解析任务异常: {}", e))?
        .map_err(|e| format!("DOCX 结构化提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "format": "markdown",
            "content": structured,
            "contentLength": structured.len(),
        }))
    }

    /// 提取 DOCX 中所有表格
    async fn execute_extract_tables(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;

        let bytes = self.load_docx_bytes(ctx, resource_id)?;

        // spawn_blocking 防止同步解析阻塞 tokio 线程
        let tables = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_docx_tables(&bytes)
        })
        .await
        .map_err(|e| format!("DOCX 解析任务异常: {}", e))?
        .map_err(|e| format!("DOCX 表格提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "table_count": tables.len(),
            "tables": tables,
        }))
    }

    /// 读取 DOCX 文档属性
    async fn execute_get_metadata(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;

        let bytes = self.load_docx_bytes(ctx, resource_id)?;

        // spawn_blocking 防止同步解析阻塞 tokio 线程
        let metadata = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_docx_metadata(&bytes)
        })
        .await
        .map_err(|e| format!("DOCX 解析任务异常: {}", e))?
        .map_err(|e| format!("DOCX 元数据读取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "metadata": metadata,
        }))
    }

    /// 将 DOCX 转换为 JSON spec（round-trip 编辑的读取端）
    async fn execute_to_spec(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;

        let bytes = self.load_docx_bytes(ctx, resource_id)?;

        // spawn_blocking 防止同步解析阻塞 tokio 线程
        let spec = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_docx_as_spec(&bytes)
        })
        .await
        .map_err(|e| format!("DOCX 解析任务异常: {}", e))?
        .map_err(|e| format!("DOCX → spec 转换失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "spec": spec,
            "message": "已将 DOCX 转换为 JSON spec。你可以修改 spec 后使用 docx_create 生成新文件。",
        }))
    }

    /// 在 DOCX 中执行查找替换，保存为新文件
    async fn execute_replace_text(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;
        let replacements_val = call
            .arguments
            .get("replacements")
            .and_then(|v| v.as_array())
            .ok_or("Missing 'replacements' parameter (array of {find, replace})")?;
        let file_name = call
            .arguments
            .get("file_name")
            .and_then(|v| v.as_str())
            .unwrap_or("edited.docx");

        // 解析替换对
        let mut replacements: Vec<(String, String)> = Vec::new();
        for r in replacements_val {
            let find = r
                .get("find")
                .and_then(|v| v.as_str())
                .ok_or("Each replacement must have a 'find' field")?;
            let replace = r
                .get("replace")
                .and_then(|v| v.as_str())
                .ok_or("Each replacement must have a 'replace' field")?;
            replacements.push((find.to_string(), replace.to_string()));
        }

        let bytes = self.load_docx_bytes(ctx, resource_id)?;

        // spawn_blocking 防止同步解析阻塞 tokio 线程
        let (new_bytes, total_count) = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.replace_text_in_docx(&bytes, &replacements)
        })
        .await
        .map_err(|e| format!("DOCX 解析任务异常: {}", e))?
        .map_err(|e| format!("DOCX 替换失败: {}", e))?;

        if total_count == 0 {
            return Ok(json!({
                "success": true,
                "resource_id": resource_id,
                "replacements_made": 0,
                "message": "未找到任何匹配项，文档未修改。",
            }));
        }

        // 保存替换后的文件到 VFS
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &new_bytes,
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Some("docx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        // ★ GAP4 修复：使用 create_file_in_folder 确保文件在学习资源中可见
        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            new_bytes.len() as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Some(&blob.hash),
            None, // original_path
            None, // folder_id = None → 根"全部文件"视图
        )
        .map_err(|e| format!("VFS 文件创建失败: {}", e))?;

        Ok(json!({
            "success": true,
            "source_resource_id": resource_id,
            "new_file_id": vfs_file.id,
            "file_name": file_name,
            "file_size": new_bytes.len(),
            "replacements_made": total_count,
            "message": format!("已完成 {} 处替换，保存为「{}」", total_count, file_name),
        }))
    }

    /// 从 JSON spec 生成 DOCX 文件并保存到 VFS
    async fn execute_create(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let spec = call
            .arguments
            .get("spec")
            .ok_or("Missing 'spec' parameter")?;
        let file_name = call
            .arguments
            .get("file_name")
            .and_then(|v| v.as_str())
            .unwrap_or("generated.docx");
        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str());

        // spawn_blocking 防止同步生成阻塞 tokio 线程
        let spec = spec.clone();
        let docx_bytes = tokio::task::spawn_blocking(move || {
            DocumentParser::generate_docx_from_spec(&spec)
        })
        .await
        .map_err(|e| format!("DOCX 生成任务异常: {}", e))?
        .map_err(|e| format!("DOCX 生成失败: {}", e))?;

        let file_size = docx_bytes.len();

        // 保存到 VFS：先存 blob，再创建 file 记录
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        // 1. 存储 Blob
        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &docx_bytes,
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Some("docx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        // 2. 创建文件记录（始终使用 create_file_in_folder 确保 folder_item 可见）
        // ★ GAP4 修复：不指定 folder_id 时传 None，文件出现在根"全部文件"视图
        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            file_size as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
            Some(&blob.hash),
            None, // original_path
            folder_id,
        )
        .map_err(|e| format!("VFS 文件创建失败: {}", e))?;

        Ok(json!({
            "success": true,
            "file_id": vfs_file.id,
            "file_name": file_name,
            "file_size": file_size,
            "format": "docx",
            "message": format!("已生成 DOCX 文件「{}」({}KB)", file_name, file_size / 1024),
        }))
    }

    /// 从 VFS 加载 DOCX 文件字节
    fn load_docx_bytes(
        &self,
        ctx: &ExecutionContext,
        resource_id: &str,
    ) -> Result<Vec<u8>, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let file = VfsFileRepo::get_file(vfs_db, resource_id)
            .map_err(|e| format!("VFS 查询失败: {}", e))?
            .ok_or_else(|| format!("文件不存在: {}", resource_id))?;

        // 优先使用 original_path 读取文件（本地导入的文件）
        if let Some(ref path) = file.original_path {
            if std::path::Path::new(path).exists() {
                return std::fs::read(path)
                    .map_err(|e| format!("文件读取失败: {}", e));
            }
        }

        // 从 blob_hash 读取 blob 文件
        if let Some(ref blob_hash) = file.blob_hash {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash) {
                return std::fs::read(&blob_path)
                    .map_err(|e| format!("Blob 读取失败: {}", e));
            }
        }

        // 回退：通过 sha256 查找 blob
        if !file.sha256.is_empty() {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, &file.sha256) {
                return std::fs::read(&blob_path)
                    .map_err(|e| format!("Blob 读取失败 (sha256): {}", e));
            }
        }

        Err(format!(
            "无法加载文件内容: {} (无可用 blob_hash 或 original_path)",
            resource_id
        ))
    }
}

impl Default for DocxToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for DocxToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(
            stripped,
            "docx_read_structured"
                | "docx_extract_tables"
                | "docx_get_metadata"
                | "docx_create"
                | "docx_to_spec"
                | "docx_replace_text"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = Self::strip_namespace(&call.name);

        log::debug!(
            "[DocxToolExecutor] Executing: {} (full: {})",
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
            "docx_read_structured" => self.execute_read_structured(call, ctx).await,
            "docx_extract_tables" => self.execute_extract_tables(call, ctx).await,
            "docx_get_metadata" => self.execute_get_metadata(call, ctx).await,
            "docx_create" => self.execute_create(call, ctx).await,
            "docx_to_spec" => self.execute_to_spec(call, ctx).await,
            "docx_replace_text" => self.execute_replace_text(call, ctx).await,
            _ => Err(format!("Unknown docx tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
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

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[DocxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
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

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[DocxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = Self::strip_namespace(tool_name);
        match stripped {
            // 读取操作低敏感
            "docx_read_structured" | "docx_extract_tables" | "docx_get_metadata"
            | "docx_to_spec" => ToolSensitivity::Low,
            // 写入/编辑操作中敏感
            "docx_create" | "docx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "DocxToolExecutor"
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
        let executor = DocxToolExecutor::new();

        assert!(executor.can_handle("builtin-docx_read_structured"));
        assert!(executor.can_handle("builtin-docx_extract_tables"));
        assert!(executor.can_handle("builtin-docx_get_metadata"));
        assert!(executor.can_handle("builtin-docx_create"));
        assert!(executor.can_handle("builtin-docx_to_spec"));
        assert!(executor.can_handle("builtin-docx_replace_text"));

        assert!(!executor.can_handle("builtin-rag_search"));
        assert!(!executor.can_handle("builtin-attachment_read"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = DocxToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-docx_read_structured"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-docx_to_spec"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-docx_create"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-docx_replace_text"),
            ToolSensitivity::Medium
        );
    }
}
