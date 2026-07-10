//! 文档解析/OCR 工具执行器（document_* 工具组）
//!
//! 让 agent 能对 VFS 中的 PDF/图片资源**主动**发起解析/OCR 管线
//! （此前只能由 UI 触发），并轮询处理进度。OCR 完成后文档全文即可被
//! resource_read / rag_search / qbank_import_document 等下游工具消费。
//!
//! ## 工具列表
//! - `document_parse`: 对指定 VFS 文件发起解析/OCR 管线（异步：发起后立即返回）
//! - `document_parse_status`: 查询解析进度与结果摘要（阶段/进度/错误/文本可用性）
//!
//! ## 与既有服务的对接
//! - 复用 `ctx.pdf_processing_service`（`vfs::pdf_processing_service::PdfProcessingService`），
//!   与 paper_save 工具"下载 PDF 入 VFS 后触发 OCR"的路径完全同源；
//! - `start_pipeline` 内部自行 spawn 后台任务并立即返回，天然满足异步任务模式；
//! - 资源 ID 解析支持 `file_*`（files 表主键）与 `res_*`（resources 表 ID，反查 files）。
//!
//! ## 敏感度
//! - `document_parse`: Medium（消耗算力，OCR 可能调用 LLM/VLM）
//! - `document_parse_status`: Low
//!
//! ## 事件发射（强制，见 tools/mod.rs 头注释）
//! - 开始: `ctx.emit_tool_call_start`
//! - 成功: `ctx.emit_tool_call_end`
//! - 失败: `ctx.emit_tool_call_error`

use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::vfs::database::VfsDatabase;
use crate::vfs::pdf_processing_service::ProcessingStage;
use crate::vfs::repos::VfsFileRepo;
use crate::vfs::types::VfsFile;

pub struct DocumentProcessingExecutor;

impl DocumentProcessingExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 清洗资源 ID：仅接受字母数字/下划线/连字符组成的 ID
    fn sanitize_id(raw: &str) -> Result<String, String> {
        let trimmed = raw
            .trim()
            .trim_matches(|c| c == '"' || c == '\'' || c == '`');
        if trimmed.is_empty()
            || !trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(format!("资源 ID 格式无效: {}", raw));
        }
        Ok(trimmed.to_string())
    }

    /// 解析资源 ID 为 VFS 文件记录
    ///
    /// 支持两种 ID 形态：
    /// - `file_*`: files 表主键，直接查询；
    /// - `res_*`: resources 表 ID，经 files.resource_id 反查。
    fn resolve_file(vfs_db: &Arc<VfsDatabase>, raw_id: &str) -> Result<VfsFile, String> {
        let id = Self::sanitize_id(raw_id)?;

        if id.starts_with("file_") {
            return VfsFileRepo::get_file(vfs_db, &id)
                .map_err(|e| format!("查询文件失败: {}", e))?
                .ok_or_else(|| format!("文件不存在: {}（请用 resource_list/resource_search 获取有效 ID）", id));
        }

        if id.starts_with("res_") {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| format!("获取数据库连接失败: {}", e))?;
            let file_id: Option<String> = conn
                .query_row(
                    "SELECT id FROM files WHERE resource_id = ?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .ok();
            drop(conn);
            let file_id = file_id.ok_or_else(|| {
                format!(
                    "资源 {} 未关联到文件（仅文件类资源支持解析/OCR；笔记/思维导图等无需解析）",
                    id
                )
            })?;
            return VfsFileRepo::get_file(vfs_db, &file_id)
                .map_err(|e| format!("查询文件失败: {}", e))?
                .ok_or_else(|| format!("文件不存在: {}", file_id));
        }

        Err(format!(
            "不支持的资源 ID 前缀: {}（仅支持 file_* 或 res_* 开头的文件类资源）",
            id
        ))
    }

    /// 校验文件媒体类型是否支持解析管线（PDF/图片）
    fn check_media_supported(file: &VfsFile) -> Result<(), String> {
        let mime = file.mime_type.as_deref().unwrap_or("");
        let supported =
            mime == "application/pdf" || mime.starts_with("image/") || file.file_type == "image";
        if !supported {
            return Err(format!(
                "文件 {}（类型: {}）不支持解析/OCR 管线，仅支持 PDF 与图片。DOCX/PPTX/XLSX 请用 docx_read_structured 等 Office 工具直接读取。",
                file.file_name,
                if mime.is_empty() { &file.file_type } else { mime }
            ));
        }
        Ok(())
    }

    /// stage 参数 → ProcessingStage 映射
    ///
    /// - `auto`（默认）: 交给服务按媒体类型决定（PDF→OCR，图片→压缩）
    /// - `ocr`: 从 OCR 阶段开始
    /// - `full`: 从文本提取阶段重跑完整管线
    fn parse_stage(args: &Value) -> Result<Option<ProcessingStage>, String> {
        match args.get("stage").and_then(|v| v.as_str()).unwrap_or("auto") {
            "auto" => Ok(None),
            "ocr" => Ok(Some(ProcessingStage::OcrProcessing)),
            "full" => Ok(Some(ProcessingStage::TextExtraction)),
            other => Err(format!(
                "无效的 stage 参数: {}（可选: auto / ocr / full）",
                other
            )),
        }
    }

    // ========================================================================
    // document_parse
    // ========================================================================

    async fn execute_parse(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter（file_* 或 res_* 开头的文件类资源 ID）")?;

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let service = ctx
            .pdf_processing_service
            .as_ref()
            .ok_or("PDF processing service not available")?;

        let file = Self::resolve_file(vfs_db, resource_id)?;
        Self::check_media_supported(&file)?;

        // 已在处理中：直接返回当前状态，避免重复触发
        if service.is_running(&file.id) {
            let status = service.get_status(&file.id).ok().flatten();
            return Ok(json!({
                "status": "already_running",
                "file_id": file.id,
                "file_name": file.file_name,
                "current_stage": status.as_ref().map(|s| s.stage.clone()),
                "message": "该文件的解析管线已在运行中，无需重复发起",
                "hint": "用 document_parse_status 轮询进度。",
            }));
        }

        let start_stage = Self::parse_stage(&call.arguments)?;

        // start_pipeline 内部会 spawn 后台任务并立即返回
        service
            .start_pipeline(&file.id, start_stage)
            .await
            .map_err(|e| format!("发起解析管线失败: {}", e))?;

        Ok(json!({
            "status": "started",
            "file_id": file.id,
            "resource_id": file.resource_id,
            "file_name": file.file_name,
            "mime_type": file.mime_type,
            "page_count": file.page_count,
            "message": "解析/OCR 管线已在后台启动",
            "hint": "OCR 可能需要数分钟，请稍后用 document_parse_status 轮询。完成后可用 resource_read 读取全文，或用 qbank_import_document 把文档内容导入题库。",
        }))
    }

    // ========================================================================
    // document_parse_status
    // ========================================================================

    async fn execute_parse_status(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let resource_id = call
            .arguments
            .get("resource_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'resource_id' parameter（file_* 或 res_* 开头的文件类资源 ID）")?;

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let service = ctx
            .pdf_processing_service
            .as_ref()
            .ok_or("PDF processing service not available")?;

        let file = Self::resolve_file(vfs_db, resource_id)?;
        let status = service
            .get_status(&file.id)
            .map_err(|e| format!("查询处理状态失败: {}", e))?;

        let extracted_chars = file
            .extracted_text
            .as_ref()
            .map(|t| t.chars().count())
            .unwrap_or(0);

        let mut payload = json!({
            "file_id": file.id,
            "resource_id": file.resource_id,
            "file_name": file.file_name,
            "mime_type": file.mime_type,
            "page_count": file.page_count,
            "is_running": service.is_running(&file.id),
            "extracted_text_chars": extracted_chars,
        });

        match status {
            Some(s) => {
                let terminal =
                    matches!(s.stage.as_str(), "completed" | "completed_with_issues" | "error");
                payload["stage"] = json!(s.stage);
                payload["progress"] = json!(s.progress);
                if let Some(err) = &s.error {
                    payload["error"] = json!(err);
                }
                if let Some(started) = s.started_at {
                    payload["started_at_ms"] = json!(started);
                }
                if let Some(completed) = s.completed_at {
                    payload["completed_at_ms"] = json!(completed);
                }
                payload["hint"] = json!(if terminal {
                    if s.stage == "error" {
                        "解析失败。可用 document_parse 重新发起（stage=full 重跑完整管线）。"
                    } else {
                        "解析完成。可用 resource_read 读取全文；如需入题库，调用 qbank_import_document；入库题目可再用 review_schedule 安排复习。"
                    }
                } else {
                    "仍在处理中，请稍后再次调用 document_parse_status。"
                });
            }
            None => {
                payload["stage"] = json!("unknown");
                payload["hint"] = json!(
                    "尚无处理状态记录（可能从未发起过解析）。可用 document_parse 发起解析/OCR。"
                );
            }
        }

        Ok(payload)
    }
}

impl Default for DocumentProcessingExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for DocumentProcessingExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        matches!(name, "document_parse" | "document_parse_status")
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!("[DocumentProcessingExecutor] Executing tool: {}", tool_name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "document_parse" => self.execute_parse(call, ctx).await,
            "document_parse_status" => self.execute_parse_status(call, ctx).await,
            _ => Err(format!("Unknown document tool: {}", tool_name)),
        };

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(value) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": value,
                    "durationMs": elapsed_ms,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    value,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!(
                        "[DocumentProcessingExecutor] Failed to save tool block: {}",
                        e
                    );
                }

                Ok(result)
            }
            Err(e) => {
                log::error!(
                    "[DocumentProcessingExecutor] Tool {} failed: {}",
                    tool_name,
                    e
                );

                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!(
                        "[DocumentProcessingExecutor] Failed to save tool block: {}",
                        e
                    );
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 发起解析：消耗算力，OCR 可能调用 LLM/VLM
            "document_parse" => ToolSensitivity::Medium,
            // 状态查询
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "DocumentProcessingExecutor"
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
        let executor = DocumentProcessingExecutor::new();
        assert!(executor.can_handle("document_parse"));
        assert!(executor.can_handle("builtin-document_parse"));
        assert!(executor.can_handle("document_parse_status"));
        assert!(executor.can_handle("builtin-document_parse_status"));

        assert!(!executor.can_handle("document_delete"));
        assert!(!executor.can_handle("resource_read"));
        assert!(!executor.can_handle("essay_grade"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = DocumentProcessingExecutor::new();
        assert_eq!(
            executor.sensitivity_level("document_parse"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-document_parse"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("document_parse_status"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn test_sanitize_id() {
        assert_eq!(
            DocumentProcessingExecutor::sanitize_id("file_abc123").unwrap(),
            "file_abc123"
        );
        assert_eq!(
            DocumentProcessingExecutor::sanitize_id("  \"res_xyz-9\"  ").unwrap(),
            "res_xyz-9"
        );
        // 含空白/特殊字符的非法 ID
        assert!(DocumentProcessingExecutor::sanitize_id("file abc").is_err());
        assert!(DocumentProcessingExecutor::sanitize_id("file_abc; DROP TABLE").is_err());
        assert!(DocumentProcessingExecutor::sanitize_id("").is_err());
    }

    #[test]
    fn test_parse_stage() {
        let auto = serde_json::json!({});
        assert_eq!(
            DocumentProcessingExecutor::parse_stage(&auto).unwrap(),
            None
        );

        let ocr = serde_json::json!({ "stage": "ocr" });
        assert_eq!(
            DocumentProcessingExecutor::parse_stage(&ocr).unwrap(),
            Some(ProcessingStage::OcrProcessing)
        );

        let full = serde_json::json!({ "stage": "full" });
        assert_eq!(
            DocumentProcessingExecutor::parse_stage(&full).unwrap(),
            Some(ProcessingStage::TextExtraction)
        );

        let invalid = serde_json::json!({ "stage": "everything" });
        assert!(DocumentProcessingExecutor::parse_stage(&invalid).is_err());
    }

    /// 构造测试用 VfsFile（通过 serde 反序列化填充必填字段）
    fn make_test_file(mime_type: &str, file_type: &str) -> VfsFile {
        serde_json::from_value(serde_json::json!({
            "id": "file_test1",
            "sha256": "hash",
            "fileName": "test.bin",
            "size": 0,
            "fileType": file_type,
            "mimeType": mime_type,
            "createdAt": "2026-07-08T00:00:00Z",
            "updatedAt": "2026-07-08T00:00:00Z",
        }))
        .expect("test VfsFile should deserialize")
    }

    #[test]
    fn test_check_media_supported() {
        let pdf = make_test_file("application/pdf", "document");
        assert!(DocumentProcessingExecutor::check_media_supported(&pdf).is_ok());

        let image = make_test_file("image/png", "image");
        assert!(DocumentProcessingExecutor::check_media_supported(&image).is_ok());

        let docx = make_test_file(
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "document",
        );
        assert!(DocumentProcessingExecutor::check_media_supported(&docx).is_err());
    }
}
