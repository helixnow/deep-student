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
// DOCX 工具执行器
// ============================================================================

/// ★ G06-P1：docx 编辑门禁措辞。replace_text 的写路径是 docx-rs 文本级全量
/// 重建（extract_as_spec → 修改 → generate_from_spec），修订/内容控件/图片/
/// OLE/复杂页眉页脚/TOC 域等 critical 特征必然静默丢失，故门禁拒绝；
/// 批注/普通页眉页脚/脚注等 high 特征放行但附 fidelity warning。
const DOCX_EDIT_GATE_WORDING: EditGateWording = EditGateWording {
    write_path: "docx-rs 文本重建",
    office_apps: "Word/WPS",
    high_features_dropped: true,
};

/// DOCX 文档工具执行器
pub struct DocxToolExecutor;

impl DocxToolExecutor {
    pub fn new() -> Self {
        Self
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

        // 文件大小安全检查（上限与提示统一由 OFFICE_DOC_PARSE_MAX_BYTES 派生，#62/ATT-09）
        if bytes.len() > OFFICE_DOC_PARSE_MAX_BYTES {
            return Err(format!(
                "DOCX 文件过大: {}MB (上限 {}MB)",
                bytes.len() / 1024 / 1024,
                OFFICE_DOC_PARSE_MAX_BYTES / 1024 / 1024
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

        // ★ G06-P1：强制 preflight（与 xlsx_edit_cells 同一门禁，复用
        // office_fidelity_inspect 的只读清点）。replace_text 的写路径是
        // docx-rs 文本级全量重建——含 critical 特征（修订/内容控件/图片/OLE/
        // 复杂页眉页脚/TOC 域）的源文件在此被拒绝，不会产生静默丢失特征的产物。
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes)?;
        enforce_edit_preflight(&preflight, &DOCX_EDIT_GATE_WORDING)?;

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

        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &new_bytes,
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_name,
            None,
            OfficeOperation::ReplaceText,
            Some(resource_id),
        )?;
        output["replacements_made"] = json!(total_count);
        // ★ G06-P1：high 特征（批注/普通页眉页脚/脚注等）放行但必须附 warning
        if let Some(warning) = build_edit_fidelity_warning(&preflight, &DOCX_EDIT_GATE_WORDING, &[])
        {
            output["fidelity_warning"] = warning;
        }
        output["message"] = json!(format!(
            "已完成 {} 处替换，保存为「{}」",
            total_count, file_name
        ));
        Ok(output)
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
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        // spawn_blocking 防止同步生成阻塞 tokio 线程
        let spec = spec.clone();
        let docx_bytes =
            tokio::task::spawn_blocking(move || DocumentParser::generate_docx_from_spec(&spec))
                .await
                .map_err(|e| format!("DOCX 生成任务异常: {}", e))?
                .map_err(|e| format!("DOCX 生成失败: {}", e))?;

        let file_size = docx_bytes.len();
        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &docx_bytes,
            "docx",
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            file_name,
            folder_id,
            OfficeOperation::Create,
            None,
        )?;
        output["message"] = json!(format!(
            "已生成 DOCX 文件「{}」({}KB)",
            file_name,
            file_size / 1024
        ));
        Ok(output)
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
        // 安全检查：验证路径不包含目录遍历，且文件确实存在
        if let Some(ref path) = file.original_path {
            if crate::unified_file_manager::is_virtual_uri(path) {
                log::debug!(
                    "[DocxToolExecutor] Skipping virtual URI original_path: {}",
                    path
                );
            } else {
                let p = std::path::Path::new(path);
                let path_str = path.replace('\\', "/");
                if path_str.contains("..") {
                    log::warn!(
                        "[DocxToolExecutor] Rejecting original_path with traversal: {}",
                        path
                    );
                } else if p.exists() {
                    return std::fs::read(p).map_err(|e| format!("文件读取失败: {}", e));
                }
            }
        }

        // 从 blob_hash 读取 blob 文件
        if let Some(ref blob_hash) = file.blob_hash {
            if let Ok(Some(blob_path)) = VfsBlobRepo::get_blob_path(vfs_db, blob_hash) {
                return std::fs::read(&blob_path).map_err(|e| format!("Blob 读取失败: {}", e));
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
        let stripped = strip_tool_namespace(tool_name);
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
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!(
            "[DocxToolExecutor] Executing: {} (full: {})",
            tool_name,
            call.name
        );

        // 发射工具调用开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

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
                    log::warn!("[DocxToolExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[DocxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 读取操作低敏感
            "docx_read_structured"
            | "docx_extract_tables"
            | "docx_get_metadata"
            | "docx_to_spec" => ToolSensitivity::Low,
            // 写入/编辑操作中敏感
            "docx_create" | "docx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            // 只读子集：结构化读取/表格提取/元数据，可并行 + 自动重试
            // （docx_to_spec 会生成新 spec 产物，不视为纯只读）
            "docx_read_structured" | "docx_extract_tables" | "docx_get_metadata" => {
                ToolConcurrency::ReadOnly
            }
            // create/replace_text/to_spec 等有副作用，保持串行（默认）
            _ => ToolConcurrency::Serial,
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

    // ========================================================================
    // G06-P1：replace_text 强制 preflight 门禁 + fidelity warning
    // ========================================================================

    use std::io::Write;

    /// 手工拼包（门禁只看包结构，critical 拒绝发生在 docx-rs 解析之前）
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

    /// docx-rs 生成的普通文档（真实可编辑路径）
    fn build_plain_docx(text: &str) -> Vec<u8> {
        let docx = docx_rs::Docx::new().add_paragraph(
            docx_rs::Paragraph::new().add_run(docx_rs::Run::new().add_text(text)),
        );
        let mut output = std::io::Cursor::new(Vec::new());
        docx.build().pack(&mut output).unwrap();
        output.into_inner()
    }

    #[test]
    fn g06_docx_replace_blocks_tracked_revisions() {
        let bytes = zip_package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/document.xml",
                br#"<w:document><w:ins w:id="7" w:author="a"><w:r><w:t>x</w:t></w:r></w:ins></w:document>"#,
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        let err = enforce_edit_preflight(&preflight, &DOCX_EDIT_GATE_WORDING).unwrap_err();
        assert!(err.contains("OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES"));
        assert!(err.contains("tracked_revisions"));
        assert!(err.contains("Word/WPS"));
        assert!(err.contains("docx-rs 文本重建"));
    }

    #[test]
    fn g06_docx_replace_blocks_images_sdt_ole_and_complex_headers() {
        let cases: Vec<(&str, &[u8], &str)> = vec![
            ("word/media/image1.png", &b"img"[..], "images"),
            (
                "word/embeddings/oleObject1.bin",
                &b"ole"[..],
                "embedded_ole",
            ),
            (
                "word/document.xml",
                &b"<w:document><w:sdt><w:sdtContent/></w:sdt></w:document>"[..],
                "content_controls",
            ),
            (
                "word/document.xml",
                &b"<w:document><w:sectPr><w:titlePg/></w:sectPr></w:document>"[..],
                "complex_headers_footers",
            ),
        ];
        for (part_name, part_bytes, expected_feature) in cases {
            let mut parts: Vec<(&str, &[u8])> = vec![("[Content_Types].xml", &b"<Types/>"[..])];
            // document.xml 类用例直接以内容为准，其余补一个空 document.xml
            if part_name != "word/document.xml" {
                parts.push(("word/document.xml", &b"<w:document/>"[..]));
            }
            parts.push((part_name, part_bytes));
            let bytes = zip_package(&parts);
            let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
            let err = enforce_edit_preflight(&preflight, &DOCX_EDIT_GATE_WORDING).unwrap_err();
            assert!(
                err.contains(expected_feature),
                "expected '{expected_feature}' in: {err}"
            );
        }
    }

    #[test]
    fn g06_docx_replace_plain_document_passes_gate_and_edits() {
        let bytes = build_plain_docx("hello world");
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        // docx-rs 自产普通文档必须可再编辑（无 critical）
        assert!(
            !preflight.has_critical(),
            "self-generated docx must be editable: {:?}",
            preflight.critical_features
        );
        enforce_edit_preflight(&preflight, &DOCX_EDIT_GATE_WORDING).unwrap();
        // 真实替换路径（DocumentParser::replace_text_in_docx）工作正常
        let (new_bytes, count) = DocumentParser::new()
            .replace_text_in_docx(&bytes, &[("world".to_string(), "deep-student".to_string())])
            .unwrap();
        assert_eq!(count, 1);
        assert_ne!(new_bytes, bytes);
        // 无 high 特征（docx-rs 默认包无批注/页眉页脚/脚注）→ 不附 warning
        assert!(build_edit_fidelity_warning(&preflight, &DOCX_EDIT_GATE_WORDING, &[]).is_none());
    }

    #[test]
    fn g06_docx_replace_comments_document_passes_with_warning() {
        let bytes = zip_package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", b"<w:document/>"),
            (
                "word/comments.xml",
                br#"<w:comments><w:comment w:id="0" w:author="a"><w:p/></w:comment></w:comments>"#,
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        // 批注是 high 而非 critical：放行
        enforce_edit_preflight(&preflight, &DOCX_EDIT_GATE_WORDING).unwrap();
        // 但交付结果必须附 fidelity warning（文本重建会丢弃批注）
        let warning = build_edit_fidelity_warning(&preflight, &DOCX_EDIT_GATE_WORDING, &[])
            .expect("comments document must carry fidelity warning");
        assert_eq!(
            warning["preserved_at_risk_features"],
            json!(["comments"])
        );
        assert_eq!(
            warning["write_path_semantics"],
            "text_only_rebuild_drops_listed_features"
        );
        assert_eq!(warning["post_edit_comparison"], "not_performed");
        assert!(warning["message"].as_str().unwrap().contains("Word/WPS"));
    }
}
