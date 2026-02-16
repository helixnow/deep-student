//! PPTX 演示文稿工具执行器
//!
//! 提供完整的 PPTX 读写编辑能力给 LLM：
//! - `builtin-pptx_read_structured` - 结构化读取 PPTX（输出 Markdown）
//! - `builtin-pptx_get_metadata` - 读取演示文稿信息（幻灯片数量等）
//! - `builtin-pptx_create` - 从 JSON spec 生成 PPTX 文件并保存到 VFS
//! - `builtin-pptx_to_spec` - 将 PPTX 转换为 JSON spec（round-trip 编辑）
//! - `builtin-pptx_replace_text` - 在 PPTX 中执行查找替换（通过 spec round-trip）
//!
//! ## 设计说明
//! 读取使用 pptx-to-md（成熟稳定），写入/创建使用 ppt-rs。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::builtin_retrieval_executor::BUILTIN_NAMESPACE;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::document_parser::DocumentParser;

// ============================================================================
// PPTX 工具执行器
// ============================================================================

/// PPTX 演示文稿工具执行器
pub struct PptxToolExecutor;

impl PptxToolExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    /// 结构化读取 PPTX（输出 Markdown）
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

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        // 文件大小安全检查（50MB 上限）
        if bytes.len() > 50 * 1024 * 1024 {
            return Err(format!(
                "PPTX 文件过大: {}MB (上限 50MB)",
                bytes.len() / 1024 / 1024
            ));
        }

        let parser = DocumentParser::new();
        let markdown = parser
            .extract_text_from_bytes("presentation.pptx", bytes)
            .map_err(|e| format!("PPTX 结构化提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "format": "markdown",
            "content": markdown,
            "contentLength": markdown.len(),
        }))
    }

    /// 读取 PPTX 演示文稿信息
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

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        let parser = DocumentParser::new();
        let markdown = parser
            .extract_text_from_bytes("presentation.pptx", bytes)
            .map_err(|e| format!("PPTX 读取失败: {}", e))?;

        // 通过 Markdown 内容估算幻灯片数量（按 # 标题计数）
        let slide_count = markdown
            .lines()
            .filter(|l| l.starts_with("# ") || l.starts_with("## "))
            .count();

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "metadata": {
                "estimated_slide_count": slide_count,
                "content_length": markdown.len(),
                "format": "pptx",
            },
        }))
    }

    /// 将 PPTX 转换为 JSON spec（round-trip 编辑的读取端）
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

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        let parser = DocumentParser::new();
        let spec = parser
            .extract_pptx_as_spec(&bytes)
            .map_err(|e| format!("PPTX → spec 转换失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "spec": spec,
            "message": "已将 PPTX 转换为 JSON spec。你可以修改 spec 后使用 pptx_create 生成新文件。",
        }))
    }

    /// 在 PPTX 中执行查找替换（通过 spec round-trip）
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
            .unwrap_or("edited.pptx");

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

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        // 通过 spec round-trip 实现替换
        let parser = DocumentParser::new();
        let mut spec = parser
            .extract_pptx_as_spec(&bytes)
            .map_err(|e| format!("PPTX 读取失败: {}", e))?;

        // 在 spec 的文本字段中执行替换
        let mut total_count = 0usize;
        let spec_str = serde_json::to_string(&spec).unwrap_or_default();
        let mut new_spec_str = spec_str.clone();
        for (find, replace) in &replacements {
            let before_len = new_spec_str.len();
            new_spec_str = new_spec_str.replace(find.as_str(), replace.as_str());
            if new_spec_str.len() != before_len || new_spec_str != spec_str {
                total_count += 1;
            }
        }

        if total_count == 0 {
            return Ok(json!({
                "success": true,
                "resource_id": resource_id,
                "replacements_made": 0,
                "message": "未找到任何匹配项，演示文稿未修改。",
            }));
        }

        // 解析修改后的 spec
        spec = serde_json::from_str(&new_spec_str)
            .map_err(|e| format!("替换后 spec 解析失败: {}", e))?;

        // 重新生成 PPTX
        let new_bytes = DocumentParser::generate_pptx_from_spec(&spec)
            .map_err(|e| format!("PPTX 重新生成失败: {}", e))?;

        // 保存到 VFS
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &new_bytes,
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Some("pptx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            new_bytes.len() as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Some(&blob.hash),
            None,
            None,
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

    /// 从 JSON spec 生成 PPTX 文件并保存到 VFS
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
            .unwrap_or("generated.pptx");
        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str());

        // 生成 PPTX 字节
        let pptx_bytes = DocumentParser::generate_pptx_from_spec(spec)
            .map_err(|e| format!("PPTX 生成失败: {}", e))?;

        let file_size = pptx_bytes.len();

        // 保存到 VFS
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &pptx_bytes,
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Some("pptx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            file_size as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
            Some(&blob.hash),
            None,
            folder_id,
        )
        .map_err(|e| format!("VFS 文件创建失败: {}", e))?;

        Ok(json!({
            "success": true,
            "file_id": vfs_file.id,
            "file_name": file_name,
            "file_size": file_size,
            "format": "pptx",
            "message": format!("已生成 PPTX 文件「{}」({}KB)", file_name, file_size / 1024),
        }))
    }

    /// 从 VFS 加载文件字节
    fn load_file_bytes(
        &self,
        ctx: &ExecutionContext,
        resource_id: &str,
    ) -> Result<Vec<u8>, String> {
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let file = VfsFileRepo::get_file(vfs_db, resource_id)
            .map_err(|e| format!("VFS 查询失败: {}", e))?
            .ok_or_else(|| format!("文件不存在: {}", resource_id))?;

        if let Some(ref path) = file.original_path {
            if std::path::Path::new(path).exists() {
                return std::fs::read(path)
                    .map_err(|e| format!("文件读取失败: {}", e));
            }
        }

        if let Some(ref blob_hash) = file.blob_hash {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash) {
                return std::fs::read(&blob_path)
                    .map_err(|e| format!("Blob 读取失败: {}", e));
            }
        }

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

impl Default for PptxToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for PptxToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = Self::strip_namespace(tool_name);
        matches!(
            stripped,
            "pptx_read_structured"
                | "pptx_get_metadata"
                | "pptx_create"
                | "pptx_to_spec"
                | "pptx_replace_text"
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
            "[PptxToolExecutor] Executing: {} (full: {})",
            tool_name,
            call.name
        );

        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

        let result = match tool_name {
            "pptx_read_structured" => self.execute_read_structured(call, ctx).await,
            "pptx_get_metadata" => self.execute_get_metadata(call, ctx).await,
            "pptx_create" => self.execute_create(call, ctx).await,
            "pptx_to_spec" => self.execute_to_spec(call, ctx).await,
            "pptx_replace_text" => self.execute_replace_text(call, ctx).await,
            _ => Err(format!("Unknown pptx tool: {}", tool_name)),
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
                    log::warn!("[PptxToolExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[PptxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = Self::strip_namespace(tool_name);
        match stripped {
            "pptx_read_structured" | "pptx_get_metadata" | "pptx_to_spec" => {
                ToolSensitivity::Low
            }
            "pptx_create" | "pptx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "PptxToolExecutor"
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
        let executor = PptxToolExecutor::new();

        assert!(executor.can_handle("builtin-pptx_read_structured"));
        assert!(executor.can_handle("builtin-pptx_get_metadata"));
        assert!(executor.can_handle("builtin-pptx_create"));
        assert!(executor.can_handle("builtin-pptx_to_spec"));
        assert!(executor.can_handle("builtin-pptx_replace_text"));

        assert!(!executor.can_handle("builtin-docx_create"));
        assert!(!executor.can_handle("builtin-rag_search"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = PptxToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-pptx_read_structured"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-pptx_to_spec"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-pptx_create"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-pptx_replace_text"),
            ToolSensitivity::Medium
        );
    }
}
