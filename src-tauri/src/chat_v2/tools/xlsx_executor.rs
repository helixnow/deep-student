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

use std::io::Cursor;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::office_fidelity_executor::{
    EditPreflight, OfficeFidelityExecutor, OFFICE_FIDELITY_CONTRACT,
};
use super::office_output::{deliver_office_bytes, OfficeOperation};
use super::strip_tool_namespace;
use super::OFFICE_DOC_PARSE_MAX_BYTES;
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

        // 文件大小安全检查（上限与提示统一由 OFFICE_DOC_PARSE_MAX_BYTES 派生，#62/ATT-09）
        if bytes.len() > OFFICE_DOC_PARSE_MAX_BYTES {
            return Err(format!(
                "XLSX 文件过大: {}MB (上限 {}MB)",
                bytes.len() / 1024 / 1024,
                OFFICE_DOC_PARSE_MAX_BYTES / 1024 / 1024
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
    ///
    /// ★ G06-P0：入口强制 preflight（复用 office_fidelity_inspect 的只读清点），
    /// critical 特征（宏/数字签名/外部链接）拒绝编辑；交付回归
    /// `deliver_office_bytes` 统一通道（与 xlsx_create / xlsx_replace_text 一致）。
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
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        // 解析编辑操作
        let mut edits: Vec<(String, String, String)> = Vec::new();
        for e in edits_val {
            let sheet = e.get("sheet").and_then(|v| v.as_str()).unwrap_or("Sheet1");
            let cell = e
                .get("cell")
                .and_then(|v| v.as_str())
                .ok_or("Each edit must have a 'cell' field (e.g. 'A1')")?;
            let value = e.get("value").and_then(|v| v.as_str()).unwrap_or("");
            edits.push((sheet.to_string(), cell.to_string(), value.to_string()));
        }

        let bytes = self.load_file_bytes(ctx, resource_id)?;

        // ★ G06-P0：强制 preflight —— 消费 office_fidelity_inspect 的 completionGate。
        // 含 critical 特征的源文件在此被拒绝，不会产生任何静默丢失特征的产物。
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes)?;
        enforce_edit_preflight(&preflight)?;

        // 🔧 2026-02-16: spawn_blocking 防止同步解析阻塞 tokio 线程
        // ★ G06-P0：编辑前快照目标单元格中的公式（umya set_value 会静默覆盖公式）
        let (new_bytes, edit_count, overwritten_formulas) = tokio::task::spawn_blocking(
            move || -> Result<(Vec<u8>, usize, Vec<String>), String> {
                let overwritten = collect_overwritten_formula_cells(&bytes, &edits);
                let parser = DocumentParser::new();
                let (new_bytes, edit_count) = parser
                    .edit_xlsx_cells(&bytes, &edits)
                    .map_err(|e| format!("XLSX 编辑失败: {}", e))?;
                Ok((new_bytes, edit_count, overwritten))
            },
        )
        .await
        .map_err(|e| format!("XLSX 解析任务异常: {}", e))??;

        if edit_count == 0 {
            return Ok(json!({
                "success": true,
                "resource_id": resource_id,
                "edits_made": 0,
                "message": "未执行任何编辑操作。",
            }));
        }

        // ★ G06-P0：回归统一交付通道（VFS / workspace、object_handle、
        // fidelity_manifest、derived_from 溯源全部由 deliver_office_bytes 负责）
        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &new_bytes,
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_name,
            folder_id,
            OfficeOperation::EditCells,
            Some(resource_id),
        )?;
        output["edits_made"] = json!(edit_count);
        if !overwritten_formulas.is_empty() {
            output["overwritten_formula_cells"] = json!(overwritten_formulas);
        }
        if let Some(warning) = build_fidelity_warning(&preflight, &overwritten_formulas) {
            output["fidelity_warning"] = warning;
        }
        output["message"] = json!(format!(
            "已编辑 {} 个单元格，保存为「{}」",
            edit_count, file_name
        ));
        Ok(output)
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

        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &new_bytes,
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_name,
            None,
            OfficeOperation::ReplaceText,
            Some(resource_id),
        )?;
        output["replacements_made"] = json!(total_count);
        output["message"] = json!(format!(
            "已完成 {} 个单元格替换，保存为「{}」",
            total_count, file_name
        ));
        Ok(output)
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
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        // 🔧 2026-02-16: spawn_blocking 防止同步生成阻塞 tokio 线程
        let spec = spec.clone();
        let xlsx_bytes =
            tokio::task::spawn_blocking(move || DocumentParser::generate_xlsx_from_spec(&spec))
                .await
                .map_err(|e| format!("XLSX 生成任务异常: {}", e))?
                .map_err(|e| format!("XLSX 生成失败: {}", e))?;

        let file_size = xlsx_bytes.len();

        let mut output = deliver_office_bytes(
            ctx,
            &call.arguments,
            &xlsx_bytes,
            "xlsx",
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            file_name,
            folder_id,
            OfficeOperation::Create,
            None,
        )?;
        output["message"] = json!(format!(
            "已生成 XLSX 文件「{}」({}KB)",
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
                    "[XlsxToolExecutor] Skipping virtual URI original_path: {}",
                    path
                );
            } else {
                let p = std::path::Path::new(path);
                let path_str = path.replace('\\', "/");
                if path_str.contains("..") {
                    log::warn!(
                        "[XlsxToolExecutor] Rejecting original_path with traversal: {}",
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

impl Default for XlsxToolExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// G06-P0：edit_cells 强制 preflight 辅助函数
// ============================================================================

/// critical 特征门禁：源文件含 macros / digital_signatures / external_links /
/// 加密容器等 critical 特征时拒绝 round-trip 编辑（umya-spreadsheet 会静默
/// 丢失这些特征）。错误为结构化 JSON（含特征清单与副本模式提示）。
fn enforce_edit_preflight(preflight: &EditPreflight) -> Result<(), String> {
    if !preflight.has_critical() {
        return Ok(());
    }
    Err(format!(
        "OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES: {}",
        json!({
            "error_code": "OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES",
            "critical_features": preflight.critical_features,
            "source_sha256": preflight.source_sha256,
            "reason": "源文件包含 critical 保真特征，umya-spreadsheet round-trip 编辑会静默丢失这些特征，已拒绝编辑",
            "hint": "可改用副本模式：在 Excel/WPS 中打开原文件手动编辑，或先另存为去除上述特征的副本后再对本工具编辑副本；完整特征清单可用 builtin-office_fidelity_inspect 查看",
        })
    ))
}

/// 收集编辑目标中原为公式的单元格地址（`Sheet!Cell` 格式）。
/// umya 的 `set_value`/`set_value_number` 会静默覆盖公式，必须在结果中显式列出。
/// 读取失败时返回空表——真正的解析错误由后续 `edit_xlsx_cells` 统一报告。
fn collect_overwritten_formula_cells(
    bytes: &[u8],
    edits: &[(String, String, String)],
) -> Vec<String> {
    let Ok(book) = umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(bytes), true) else {
        return Vec::new();
    };
    let mut overwritten: Vec<String> = Vec::new();
    for (sheet_name, cell_ref, _) in edits {
        let Some(ws) = book.get_sheet_by_name(sheet_name) else {
            continue;
        };
        let Some(cell) = ws.get_cell(cell_ref.as_str()) else {
            continue;
        };
        if cell.is_formula() {
            let address = format!("{}!{}", sheet_name, cell_ref);
            if !overwritten.contains(&address) {
                overwritten.push(address);
            }
        }
    }
    overwritten
}

/// 构建交付结果中的 fidelity warning。
/// 触发条件：源文件含 high 风险特征（charts/pivot_tables/defined_names/
/// data_validation/formulas 等），或本次编辑覆盖了公式单元格。
/// 普通文件（无 high 特征、未覆盖公式）返回 None，结果 JSON 不出现该字段。
fn build_fidelity_warning(
    preflight: &EditPreflight,
    overwritten_formulas: &[String],
) -> Option<Value> {
    if preflight.high_features.is_empty() && overwritten_formulas.is_empty() {
        return None;
    }
    Some(json!({
        "contract": OFFICE_FIDELITY_CONTRACT,
        "risk": preflight.risk,
        "source_sha256": preflight.source_sha256,
        "feature_set_hash": preflight.feature_set_hash,
        "preserved_at_risk_features": preflight.high_features,
        "overwritten_formula_cells": overwritten_formulas,
        "post_edit_comparison": "not_performed",
        "message": "源文件包含高保真风险特征，本次编辑未做编辑后结构对比，建议在 Excel/WPS 中打开产物核对",
    }))
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

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

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
                    log::warn!("[XlsxToolExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[XlsxToolExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "xlsx_read_structured"
            | "xlsx_extract_tables"
            | "xlsx_get_metadata"
            | "xlsx_to_spec" => ToolSensitivity::Low,
            "xlsx_create" | "xlsx_edit_cells" | "xlsx_replace_text" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        match strip_tool_namespace(tool_name) {
            // 只读子集：结构化读取/表格提取/元数据，可并行 + 自动重试
            // （xlsx_to_spec 会生成新 spec 产物，不视为纯只读）
            "xlsx_read_structured" | "xlsx_extract_tables" | "xlsx_get_metadata" => {
                ToolConcurrency::ReadOnly
            }
            // create/edit_cells/replace_text/to_spec 等有副作用，保持串行（默认）
            _ => ToolConcurrency::Serial,
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
    use std::io::Write;

    /// 含一个公式单元格（Sheet1!B1 = SUM(A1:A2)）的真实 xlsx
    fn build_formula_xlsx() -> Vec<u8> {
        let mut book = umya_spreadsheet::new_file();
        {
            let sheet = book.get_sheet_by_name_mut("Sheet1").unwrap();
            sheet.get_cell_mut("A1").set_value_number(1.0);
            sheet.get_cell_mut("A2").set_value_number(2.0);
            sheet.get_cell_mut("B1").set_formula("SUM(A1:A2)");
        }
        let mut output = Cursor::new(Vec::new());
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut output).unwrap();
        output.into_inner()
    }

    /// 纯值普通 xlsx
    fn build_plain_xlsx() -> Vec<u8> {
        let mut book = umya_spreadsheet::new_file();
        {
            let sheet = book.get_sheet_by_name_mut("Sheet1").unwrap();
            sheet.get_cell_mut("A1").set_value("hello");
        }
        let mut output = Cursor::new(Vec::new());
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut output).unwrap();
        output.into_inner()
    }

    /// 含宏的包（preflight 只看包结构；critical 拒绝发生在 umya 解析之前，
    /// 无需构造 umya 可读的真实 xlsm）
    fn build_macro_xlsx() -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            let options = zip::write::FileOptions::default();
            for (name, bytes) in [
                ("[Content_Types].xml", &b"<Types/>"[..]),
                ("xl/workbook.xml", &b"<workbook/>"[..]),
                ("xl/vbaProject.bin", &b"macro payload"[..]),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        output.into_inner()
    }

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

    // ========================================================================
    // G06-P0：强制 preflight + 公式覆盖披露
    // ========================================================================

    #[test]
    fn g06_edit_cells_preflight_blocks_macro_workbook() {
        let bytes = build_macro_xlsx();
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert!(preflight.has_critical());
        let err = enforce_edit_preflight(&preflight).unwrap_err();
        assert!(err.contains("OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES"));
        assert!(err.contains("macros"));
        assert!(err.contains("副本"));
    }

    #[test]
    fn g06_edit_cells_formula_workbook_allows_edit_with_warning() {
        let bytes = build_formula_xlsx();
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        // 公式是 high 而非 critical：门禁放行
        assert!(!preflight.has_critical());
        assert!(preflight.high_features.iter().any(|f| f == "formulas"));
        enforce_edit_preflight(&preflight).unwrap();
        // 编辑非公式单元格：无公式被覆盖
        let edits = vec![("Sheet1".to_string(), "C1".to_string(), "42".to_string())];
        let overwritten = collect_overwritten_formula_cells(&bytes, &edits);
        assert!(overwritten.is_empty());
        // 但交付结果必须附 fidelity warning（源文件含 formulas 高风险特征）
        let warning = build_fidelity_warning(&preflight, &overwritten)
            .expect("formula workbook must carry fidelity warning");
        assert_eq!(
            warning["preserved_at_risk_features"],
            json!(["formulas"])
        );
        assert_eq!(warning["post_edit_comparison"], "not_performed");
    }

    #[test]
    fn g06_edit_cells_non_formula_edit_preserves_other_formulas() {
        let bytes = build_formula_xlsx();
        let parser = DocumentParser::new();
        let edits = vec![("Sheet1".to_string(), "C1".to_string(), "42".to_string())];
        let (new_bytes, count) = parser.edit_xlsx_cells(&bytes, &edits).unwrap();
        assert_eq!(count, 1);
        // 未被编辑的公式单元格在产物中仍然存活
        let book =
            umya_spreadsheet::reader::xlsx::read_reader(Cursor::new(&new_bytes), true).unwrap();
        let ws = book.get_sheet_by_name("Sheet1").unwrap();
        assert!(ws.get_cell("B1").unwrap().is_formula());
        assert_eq!(ws.get_cell("C1").unwrap().get_value(), "42");
    }

    #[test]
    fn g06_edit_cells_overwritten_formula_cells_are_listed() {
        let bytes = build_formula_xlsx();
        let edits = vec![
            ("Sheet1".to_string(), "B1".to_string(), "99".to_string()), // 公式单元格
            ("Sheet1".to_string(), "A1".to_string(), "5".to_string()),  // 普通值
            ("Sheet1".to_string(), "Z9".to_string(), "x".to_string()),  // 空单元格
        ];
        let overwritten = collect_overwritten_formula_cells(&bytes, &edits);
        assert_eq!(overwritten, vec!["Sheet1!B1".to_string()]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        let warning = build_fidelity_warning(&preflight, &overwritten).unwrap();
        assert_eq!(
            warning["overwritten_formula_cells"],
            json!(["Sheet1!B1"])
        );
    }

    #[test]
    fn g06_edit_cells_plain_workbook_has_no_warning() {
        let bytes = build_plain_xlsx();
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert!(!preflight.has_critical());
        assert!(preflight.high_features.is_empty());
        enforce_edit_preflight(&preflight).unwrap();
        let edits = vec![("Sheet1".to_string(), "A1".to_string(), "world".to_string())];
        let overwritten = collect_overwritten_formula_cells(&bytes, &edits);
        assert!(overwritten.is_empty());
        assert!(build_fidelity_warning(&preflight, &overwritten).is_none());
    }
}
