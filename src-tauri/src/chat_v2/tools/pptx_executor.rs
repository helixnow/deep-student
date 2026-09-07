//! PPTX 演示文稿工具执行器
//!
//! 提供完整的 PPTX 读写编辑能力给 LLM：
//! - `builtin-pptx_read_structured` - 结构化读取 PPTX（输出 Markdown）
//! - `builtin-pptx_get_metadata` - 精确读取演示文稿元数据（幻灯片数量、文本总长度）
//! - `builtin-pptx_extract_tables` - 提取 PPTX 中所有表格为结构化 JSON
//! - `builtin-pptx_create` - 从 JSON spec 生成 PPTX 文件并保存到 VFS
//! - `builtin-pptx_to_spec` - 将 PPTX 转换为 JSON spec（round-trip 编辑）
//! - `builtin-pptx_replace_text` - 在 PPTX 中执行查找替换（通过 spec round-trip）
//!
//! ## 设计说明
//! 读取使用 pptx-to-md（成熟稳定），写入/创建使用 ppt-rs。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::office_fidelity_executor::{
    build_edit_fidelity_warning, enforce_edit_preflight, EditGateWording, OfficeFidelityExecutor,
};
use super::office_output::{deliver_office_bytes, OfficeOperation};
use super::strip_tool_namespace;
use super::OFFICE_DOC_PARSE_MAX_BYTES;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::document_parser::DocumentParser;

// ============================================================================
// PPTX 工具执行器
// ============================================================================

/// ★ G06-P1：pptx 编辑门禁措辞。replace_text 的写路径是 markdown spec 文本级
/// 全量重建（extract_as_spec → 修改 → ppt-rs 重新生成），媒体/嵌入 OLE 对象
/// 必然静默丢失（critical 拒绝）；母版/备注/动画/图表/SmartArt 同样丢失但
/// 词法无法区分默认与自定义母版，保守放行并附 fidelity warning。
const PPTX_EDIT_GATE_WORDING: EditGateWording = EditGateWording {
    write_path: "pptx spec 文本重建",
    office_apps: "PowerPoint/WPS",
    high_features_dropped: true,
};

/// PPTX 演示文稿工具执行器
pub struct PptxToolExecutor;

impl PptxToolExecutor {
    pub fn new() -> Self {
        Self
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

        // 文件大小安全检查（上限与提示统一由 OFFICE_DOC_PARSE_MAX_BYTES 派生，#62/ATT-09）
        if bytes.len() > OFFICE_DOC_PARSE_MAX_BYTES {
            return Err(format!(
                "PPTX 文件过大: {}MB (上限 {}MB)",
                bytes.len() / 1024 / 1024,
                OFFICE_DOC_PARSE_MAX_BYTES / 1024 / 1024
            ));
        }

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let markdown = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_text_from_bytes("presentation.pptx", bytes)
        })
        .await
        .map_err(|e| format!("PPTX 解析任务异常: {}", e))?
        .map_err(|e| format!("PPTX 结构化提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "format": "markdown",
            "content": markdown,
            "contentLength": markdown.len(),
        }))
    }

    /// ★ GAP-1 修复：精确读取 PPTX 演示文稿元数据
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
            parser.extract_pptx_metadata(&bytes)
        })
        .await
        .map_err(|e| format!("PPTX 解析任务异常: {}", e))?
        .map_err(|e| format!("PPTX 元数据读取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "metadata": metadata,
        }))
    }

    /// ★ GAP-3 修复：提取 PPTX 中所有表格为结构化 JSON
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
            parser.extract_pptx_tables(&bytes)
        })
        .await
        .map_err(|e| format!("PPTX 解析任务异常: {}", e))?
        .map_err(|e| format!("PPTX 表格提取失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "table_count": tables.len(),
            "tables": tables,
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

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let spec = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_pptx_as_spec(&bytes)
        })
        .await
        .map_err(|e| format!("PPTX 解析任务异常: {}", e))?
        .map_err(|e| format!("PPTX → spec 转换失败: {}", e))?;

        Ok(json!({
            "success": true,
            "resource_id": resource_id,
            "spec": spec,
            "message": "已将 PPTX 转换为 JSON spec。你可以修改 spec 后使用 pptx_create 生成新文件。",
        }))
    }

    /// ★ GAP-2 修复：在 PPTX 中执行查找替换（通过 spec round-trip），覆盖 subtitle / table rows
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

        // ★ G06-P1：强制 preflight（与 xlsx_edit_cells 同一门禁，复用
        // office_fidelity_inspect 的只读清点）。replace_text 的写路径是
        // 文本级全量重建——含 critical 特征（媒体/嵌入 OLE 对象）的源文件在此
        // 被拒绝，不会产生静默丢失特征的产物。
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes)?;
        enforce_edit_preflight(&preflight, &PPTX_EDIT_GATE_WORDING)?;

        // 通过 spec round-trip 实现替换
        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        let mut spec = tokio::task::spawn_blocking(move || {
            let parser = DocumentParser::new();
            parser.extract_pptx_as_spec(&bytes)
        })
        .await
        .map_err(|e| format!("PPTX 解析任务异常: {}", e))?
        .map_err(|e| format!("PPTX 读取失败: {}", e))?;

        let mut total_count = 0usize;

        /// 辅助函数：对字符串应用所有替换对，返回是否有变化
        fn apply_replacements(original: &str, replacements: &[(String, String)]) -> Option<String> {
            let mut result = original.to_string();
            for (find, replace) in replacements {
                result = result.replace(find.as_str(), replace.as_str());
            }
            if result != original {
                Some(result)
            } else {
                None
            }
        }

        // 替换顶层 title
        if let Some(title) = spec
            .get("title")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            if let Some(new_title) = apply_replacements(&title, &replacements) {
                spec["title"] = serde_json::Value::String(new_title);
                total_count += 1;
            }
        }

        // 替换每张幻灯片的所有文本字段
        if let Some(slides) = spec.get_mut("slides").and_then(|v| v.as_array_mut()) {
            for slide in slides.iter_mut() {
                // 替换幻灯片 title
                if let Some(st) = slide
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                {
                    if let Some(new_st) = apply_replacements(&st, &replacements) {
                        slide["title"] = serde_json::Value::String(new_st);
                        total_count += 1;
                    }
                }

                // ★ GAP-2: 替换 subtitle（title 类型幻灯片）
                if let Some(sub) = slide
                    .get("subtitle")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                {
                    if let Some(new_sub) = apply_replacements(&sub, &replacements) {
                        slide["subtitle"] = serde_json::Value::String(new_sub);
                        total_count += 1;
                    }
                }

                // 替换 bullets 数组中的每一项
                if let Some(bullets) = slide.get_mut("bullets").and_then(|v| v.as_array_mut()) {
                    for bullet in bullets.iter_mut() {
                        if let Some(bt) = bullet.as_str().map(|s| s.to_string()) {
                            if let Some(new_bt) = apply_replacements(&bt, &replacements) {
                                *bullet = serde_json::Value::String(new_bt);
                                total_count += 1;
                            }
                        }
                    }
                }

                // ★ GAP-2: 替换 table headers
                if let Some(headers) = slide.get_mut("headers").and_then(|v| v.as_array_mut()) {
                    for header in headers.iter_mut() {
                        if let Some(ht) = header.as_str().map(|s| s.to_string()) {
                            if let Some(new_ht) = apply_replacements(&ht, &replacements) {
                                *header = serde_json::Value::String(new_ht);
                                total_count += 1;
                            }
                        }
                    }
                }

                // ★ GAP-2: 替换 table rows
                if let Some(rows) = slide.get_mut("rows").and_then(|v| v.as_array_mut()) {
                    for row in rows.iter_mut() {
                        if let Some(cells) = row.as_array_mut() {
                            for cell in cells.iter_mut() {
                                if let Some(ct) = cell.as_str().map(|s| s.to_string()) {
                                    if let Some(new_ct) = apply_replacements(&ct, &replacements) {
                                        *cell = serde_json::Value::String(new_ct);
                                        total_count += 1;
                                    }
                                }
                            }
                        }
                    }
                }
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

        // 重新生成 PPTX
        // 🔧 2026-02-16: spawn_blocking 防止同步生成阻塞 tokio 线程
        let new_bytes =
            tokio::task::spawn_blocking(move || DocumentParser::generate_pptx_from_spec(&spec))
                .await
                .map_err(|e| format!("PPTX 生成任务异常: {}", e))?
                .map_err(|e| format!("PPTX 重新生成失败: {}", e))?;

        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &new_bytes,
            "pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            file_name,
            None,
            OfficeOperation::ReplaceText,
            Some(resource_id),
        )?;
        output["replacements_made"] = json!(total_count);
        // ★ G06-P1：high 特征（母版/备注/动画/图表/SmartArt 等）放行但必须附 warning
        if let Some(warning) = build_edit_fidelity_warning(&preflight, &PPTX_EDIT_GATE_WORDING, &[])
        {
            output["fidelity_warning"] = warning;
        }
        output["message"] = json!(format!(
            "已完成 {} 处替换，保存为「{}」",
            total_count, file_name
        ));
        Ok(output)
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
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        // 生成 PPTX 字节
        // 🔧 2026-02-16: spawn_blocking 防止同步生成阻塞 tokio 线程
        let spec = spec.clone();
        let pptx_bytes =
            tokio::task::spawn_blocking(move || DocumentParser::generate_pptx_from_spec(&spec))
                .await
                .map_err(|e| format!("PPTX 生成任务异常: {}", e))?
                .map_err(|e| format!("PPTX 生成失败: {}", e))?;

        let file_size = pptx_bytes.len();

        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &pptx_bytes,
            "pptx",
            "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            file_name,
            folder_id,
            OfficeOperation::Create,
            None,
        )?;
        output["message"] = json!(format!(
            "已生成 PPTX 文件「{}」({}KB)",
            file_name,
            file_size / 1024
        ));
        Ok(output)
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
            if crate::unified_file_manager::is_virtual_uri(path) {
                log::debug!(
                    "[PptxToolExecutor] Skipping virtual URI original_path: {}",
                    path
                );
            } else {
                let p = std::path::Path::new(path);
                let path_str = path.replace('\\', "/");
                if path_str.contains("..") {
                    log::warn!(
                        "[PptxToolExecutor] Rejecting original_path with traversal: {}",
                        path
                    );
                } else if p.exists() {
                    return std::fs::read(p).map_err(|e| format!("文件读取失败: {}", e));
                }
            }
        }

        if let Some(ref blob_hash) = file.blob_hash {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash) {
                return std::fs::read(&blob_path).map_err(|e| format!("Blob 读取失败: {}", e));
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
        let stripped = strip_tool_namespace(tool_name);
        matches!(
            stripped,
            "pptx_read_structured"
                | "pptx_get_metadata"
                | "pptx_extract_tables"
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
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[PptxToolExecutor] Executing: {} (full: {})",
            tool_name,
            call.name
        );

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "pptx_read_structured" => self.execute_read_structured(call, ctx).await,
            "pptx_get_metadata" => self.execute_get_metadata(call, ctx).await,
            "pptx_extract_tables" => self.execute_extract_tables(call, ctx).await,
            "pptx_create" => self.execute_create(call, ctx).await,
            "pptx_to_spec" => self.execute_to_spec(call, ctx).await,
            "pptx_replace_text" => self.execute_replace_text(call, ctx).await,
            _ => Err(format!("Unknown pptx tool: {}", tool_name)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

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
                ctx.emit_tool_call_error(&e);

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
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "pptx_read_structured"
            | "pptx_get_metadata"
            | "pptx_extract_tables"
            | "pptx_to_spec" => ToolSensitivity::Low,
            "pptx_create" | "pptx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            // 只读子集：结构化读取/表格提取/元数据，可并行 + 自动重试
            // （pptx_to_spec 会生成新 spec 产物，不视为纯只读）
            "pptx_read_structured" | "pptx_extract_tables" | "pptx_get_metadata" => {
                ToolConcurrency::ReadOnly
            }
            // create/replace_text/to_spec 等有副作用，保持串行（默认）
            _ => ToolConcurrency::Serial,
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
        assert!(executor.can_handle("builtin-pptx_extract_tables"));
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
            executor.sensitivity_level("builtin-pptx_extract_tables"),
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

    // ========================================================================
    // G06-P1：replace_text 强制 preflight 门禁 + fidelity warning
    // ========================================================================

    use std::io::Write;

    /// 手工拼包（门禁只看包结构，critical 拒绝发生在 spec 提取之前）
    fn zip_package(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = std::io::Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            let options = zip::write::FileOptions::default();
            for (name, bytes) in parts {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        output.into_inner()
    }

    #[test]
    fn g06_pptx_replace_blocks_media_and_embedded_ole() {
        let cases: Vec<(&str, &[u8], &str)> = vec![
            ("ppt/media/image1.png", &b"img"[..], "media"),
            ("ppt/media/video1.mp4", &b"vid"[..], "media"),
            (
                "ppt/embeddings/oleObject1.bin",
                &b"ole"[..],
                "embedded_ole",
            ),
        ];
        for (part_name, part_bytes, expected_feature) in cases {
            let bytes = zip_package(&[
                ("[Content_Types].xml", &b"<Types/>"[..]),
                ("ppt/presentation.xml", &b"<p:presentation/>"[..]),
                (part_name, part_bytes),
            ]);
            let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
            let err = enforce_edit_preflight(&preflight, &PPTX_EDIT_GATE_WORDING).unwrap_err();
            assert!(err.contains("OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES"));
            assert!(
                err.contains(expected_feature),
                "expected '{expected_feature}' in: {err}"
            );
            assert!(err.contains("PowerPoint/WPS"));
            assert!(err.contains("pptx spec 文本重建"));
        }
    }

    #[test]
    fn g06_pptx_replace_masters_and_notes_pass_with_warning() {
        let bytes = zip_package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("ppt/presentation.xml", b"<p:presentation/>"),
            ("ppt/slideMasters/slideMaster1.xml", b"<p:sldMaster/>"),
            ("ppt/notesSlides/notesSlide1.xml", b"<p:notes/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        // 母版/备注是 high 而非 critical（词法无法区分默认与自定义母版，保守放行）
        enforce_edit_preflight(&preflight, &PPTX_EDIT_GATE_WORDING).unwrap();
        // 但交付结果必须附 fidelity warning（文本重建会重新生成默认母版、丢弃备注）
        let warning = build_edit_fidelity_warning(&preflight, &PPTX_EDIT_GATE_WORDING, &[])
            .expect("masters/notes deck must carry fidelity warning");
        let at_risk = warning["preserved_at_risk_features"].as_array().unwrap();
        assert!(at_risk.iter().any(|f| f == "slide_masters"));
        assert!(at_risk.iter().any(|f| f == "speaker_notes"));
        assert_eq!(
            warning["write_path_semantics"],
            "text_only_rebuild_drops_listed_features"
        );
        assert!(warning["message"]
            .as_str()
            .unwrap()
            .contains("PowerPoint/WPS"));
    }

    #[test]
    fn g06_pptx_replace_self_generated_deck_passes_gate_and_edits() {
        // ppt-rs 自产演示文稿必须可再编辑（无 critical：无 media/ole）
        let spec = json!({
            "title": "季度汇报",
            "slides": [
                { "type": "content", "title": "要点", "bullets": ["hello world"] }
            ]
        });
        let bytes = DocumentParser::generate_pptx_from_spec(&spec).unwrap();
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert!(
            !preflight.has_critical(),
            "self-generated pptx must be editable: {:?}",
            preflight.critical_features
        );
        enforce_edit_preflight(&preflight, &PPTX_EDIT_GATE_WORDING).unwrap();
        // spec round-trip（replace_text 的读端）可正常提取
        let extracted = DocumentParser::new().extract_pptx_as_spec(&bytes).unwrap();
        assert!(extracted["slides"].as_array().is_some_and(|s| !s.is_empty()));
    }
}
