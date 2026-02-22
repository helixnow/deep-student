//! XLSX 电子表格工具执行器
//!
//! 提供完整的 XLSX 读写编辑能力给 LLM：
//! - `builtin-xlsx_read_structured` - 结构化读取 XLSX（复用 calamine，输出 Markdown 表格）
//! - `builtin-xlsx_extract_tables` - 提取所有工作表为结构化 JSON
//! - `builtin-xlsx_create` - 从 JSON spec 生成 XLSX 文件并保存到 VFS
//! - `builtin-xlsx_to_spec` - 将 XLSX 转换为 JSON spec（round-trip 编辑）
//! - `builtin-xlsx_edit_cells` - 编辑指定单元格并保存为新文件
//! - `builtin-xlsx_replace_text` - 在 XLSX 中执行查找替换并保存为新文件
//!
//! ## 设计说明
//! 读取使用 calamine（高性能只读解析），写入/编辑使用 umya-spreadsheet（round-trip）。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::document_parser::DocumentParser;

// ============================================================================
// XLSX 工具执行器
// ============================================================================

/// XLSX 电子表格工具执行器
pub struct XlsxToolExecutor;

impl XlsxToolExecutor {
    pub fn new() -> Self {
        Self
    }


    /// 结构化读取 XLSX（输出 Markdown 表格格式）
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

        if bytes.len() > 50 * 1024 * 1024 {
            return Err(format!(
                "XLSX 文件过大: {}MB (上限 50MB)",
                bytes.len() / 1024 / 1024
            ));
        }

        // 使用 calamine 提取文本（已有实现）
        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let content = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_text_from_bytes("spreadsheet.xlsx", bytes)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX 结构化提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "format": "text",
            "content": content,
            "contentLength": content.len(),
        }))
    }

    /// 提取 XLSX 中所有工作表的结构化表格数据
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

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let tables = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_xlsx_tables(&bytes)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX 表格提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "sheet_count": tables.len(),
            "tables": tables,
        }))
    }

    /// ★ GAP-4 修复：读取 XLSX 文件元数据（工作表数量/名称/行列数）
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

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let metadata = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_xlsx_metadata(&bytes)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX 元数据读取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "metadata": metadata,
        }))
    }

    /// 将 XLSX 转换为 JSON spec（round-trip 编辑的读取端）
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

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let spec = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_xlsx_as_spec(&bytes)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX → spec 转换失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "spec": spec,
            "message": "已将 XLSX 转换为 JSON spec。你可以修改 spec 后使用 xlsx_create 生成新文件。",
        }))
    }

    /// 编辑指定单元格并保存为新文件
    async fn execute_edit_cells(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter")?;
        let edits_val = call
            .arguments
            .get("edits")
            .and_then(|v| v.as_array())
            .ok_or("Missing 'edits' parameter (array of {sheet, cell, value})")?;
        let file_name = call
            .arguments
            .get("file_name")
            .and_then(|v| v.as_str())
            .unwrap_or("edited.xlsx");

        // 解析编辑操作
        let mut edits: Vec<(String, String, String)> = Vec::new();
        for e in edits_val {
            let sheet = e
                .get("sheet")
                .and_then(|v| v.as_str())
                .unwrap_or("Sheet1");
            let cell = e
                .get("cell")
                .and_then(|v| v.as_str())
                .ok_or("Each edit must have a 'cell' field (e.g. 'A1')")?;
            let value = e
                .get("value")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            edits.push((sheet.to_string(), cell.to_string(), value.to_string()));
        }

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let (new_bytes, edit_count) = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.edit_xlsx_cells(&bytes, &edits)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX 编辑失败: {}", e))?;

        if edit_count == 0 {
            return Ok(json!({
                "success": true,
                "resource_id": resource_id,
                "edits_made": 0,
                "message": "未执行任何编辑操作。",
            }));
        }

        // 保存到 VFS
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &new_bytes,
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Some("xlsx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            new_bytes.len() as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
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
            "edits_made": edit_count,
            "message": format!("已编辑 {} 个单元格，保存为「{}」", edit_count, file_name),
        }))
    }

    /// 在 XLSX 中执行查找替换，保存为新文件
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
            .unwrap_or("edited.xlsx");

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

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let (new_bytes, total_count) = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.replace_text_in_xlsx(&bytes, &replacements)
        })
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))?
        .map_err(|e| format!("XLSX 替换失败: {}", e))?;

        if total_count == 0 {
            return Ok(json!({
                "success": true,
                "resource_id": resource_id,
                "replacements_made": 0,
                "message": "未找到任何匹配项，表格未修改。",
            }));
        }

        // 保存到 VFS
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &new_bytes,
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Some("xlsx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            new_bytes.len() as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
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
            "message": format!("已完成 {} 个单元格替换，保存为「{}」", total_count, file_name),
        }))
    }

    /// 从 JSON spec 生成 XLSX 文件并保存到 VFS
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
            .unwrap_or("generated.xlsx");
        let folder_id = call
            .arguments
            .get("folder_id")
            .and_then(|v| v.as_str());

        // 🔧 2026-02-16: spawn_blocking 防止同步生成阻塞 tokio 线程
        let spec = spec.clone();
        let xlsx_bytes = tokio::task::spawn_blocking(move || {
            DocumentParser::generate_xlsx_from_spec(&spec)
        })
        .await
        .map_err(|e| format!("XLSX 生成任务异常: {}", e))?
        .map_err(|e| format!("XLSX 生成失败: {}", e))?;

        let file_size = xlsx_bytes.len();

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

        let blob = VfsBlobRepo::store_blob(
            vfs_db,
            &xlsx_bytes,
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
            Some("xlsx"),
        )
        .map_err(|e| format!("VFS Blob 存储失败: {}", e))?;

        let vfs_file = VfsFileRepo::create_file_in_folder(
            vfs_db,
            &blob.hash,
            file_name,
            file_size as i64,
            "document",
            Some("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
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
            "format": "xlsx",
            "message": format!("已生成 XLSX 文件「{}」({}KB)", file_name, file_size / 1024),
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

impl Default for XlsxToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for XlsxToolExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "xlsx_read_structured"
                | "xlsx_extract_tables"
                | "xlsx_get_metadata"
                | "xlsx_create"
                | "xlsx_to_spec"
                | "xlsx_edit_cells"
                | "xlsx_replace_text"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[XlsxToolExecutor] Executing: {} (full: {})",
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
            "xlsx_read_structured" => self.execute_read_structured(call, ctx).await,
            "xlsx_extract_tables" => self.execute_extract_tables(call, ctx).await,
            "xlsx_get_metadata" => self.execute_get_metadata(call, ctx).await,
            "xlsx_create" => self.execute_create(call, ctx).await,
            "xlsx_to_spec" => self.execute_to_spec(call, ctx).await,
            "xlsx_edit_cells" => self.execute_edit_cells(call, ctx).await,
            "xlsx_replace_text" => self.execute_replace_text(call, ctx).await,
            _ => Err(format!("Unknown xlsx tool: {}", tool_name)),
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
                    log::warn!("[XlsxToolExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[XlsxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "xlsx_read_structured" | "xlsx_extract_tables" | "xlsx_get_metadata"
            | "xlsx_to_spec" => ToolSensitivity::Low,
            "xlsx_create" | "xlsx_edit_cells" | "xlsx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "XlsxToolExecutor"
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
        let executor = XlsxToolExecutor::new();

        assert!(executor.can_handle("builtin-xlsx_read_structured"));
        assert!(executor.can_handle("builtin-xlsx_extract_tables"));
        assert!(executor.can_handle("builtin-xlsx_get_metadata"));
        assert!(executor.can_handle("builtin-xlsx_create"));
        assert!(executor.can_handle("builtin-xlsx_to_spec"));
        assert!(executor.can_handle("builtin-xlsx_edit_cells"));
        assert!(executor.can_handle("builtin-xlsx_replace_text"));

        assert!(!executor.can_handle("builtin-docx_create"));
        assert!(!executor.can_handle("builtin-pptx_create"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = XlsxToolExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_read_structured"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_to_spec"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_get_metadata"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_create"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_edit_cells"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-xlsx_replace_text"),
            ToolSensitivity::Medium
        );
    }
}
