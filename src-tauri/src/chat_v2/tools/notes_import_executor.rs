//! 笔记库 zip 导入工具执行器
//!
//! 把既有的 `notes_import` 后端能力（`cmd/notes.rs` + `notes_exporter::NotesImporter`）
//! 暴露为聊天 Agent 工具，补齐「AI 只能 shell unzip 手工拼装」的断裂点：
//! 手工拼装无法等价复刻冲突策略与附件/资产还原逻辑。
//!
//! ## 工具
//! - `builtin-notes_import` / `notes_import`（Medium）：
//!   入参为 attachment_stage 物化后的 staged zip（`root_id=temp` + `relative_path`），
//!   以及与 UI 一致的冲突策略枚举（skip / overwrite / merge_keep_newer）。
//!
//! ## 安全设计
//! - 会话归属校验：staged 路径只能落在**当前会话**的 temp root 内
//!   （`temp_root(app, ctx.session_id)` 按会话隔离解析 +
//!   `resolve_staged_file_in_temp_root` 的路径穿越/symlink 校验）。
//! - 导入本体完全复用 `NotesImporter::import_with_options`，与设置页 UI 导入
//!   等价（含 zip 解析、冲突策略与附件还原）。

use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Manager;

use super::attachment_stage_executor::resolve_staged_file_in_temp_root;
use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::temp_root;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

const LOG_PREFIX: &str = "[NotesImportExecutor]";

pub struct NotesImportExecutor;

impl NotesImportExecutor {
    pub fn new() -> Self {
        Self
    }

    async fn execute_import(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let root_id = call
            .arguments
            .get("root_id")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("temp");
        if !root_id.eq_ignore_ascii_case("temp") {
            return Err(format!(
                "notes_import only accepts root_id=temp (staged attachments), got '{}'",
                root_id
            ));
        }
        let relative_path = call
            .arguments
            .get("relative_path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or("Missing 'relative_path' parameter (use the path returned by attachment_stage)")?
            .to_string();
        let conflict_strategy_raw = call
            .arguments
            .get("conflict_strategy")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("skip")
            .to_string();
        // 与 UI（notesApi.importNotes）一致的枚举；未知值 fail-closed
        let conflict_strategy = match conflict_strategy_raw.as_str() {
            "skip" => crate::notes_exporter::ImportConflictStrategy::Skip,
            "overwrite" => crate::notes_exporter::ImportConflictStrategy::Overwrite,
            "merge_keep_newer" => crate::notes_exporter::ImportConflictStrategy::MergeKeepNewer,
            other => {
                return Err(format!(
                    "Invalid conflict_strategy '{}': expected skip, overwrite or merge_keep_newer",
                    other
                ))
            }
        };

        let state = ctx.window_ref().state::<AppState>();
        let notes_database = state.notes_database.clone();
        let file_manager = state.file_manager.clone();
        let vfs_db = state.vfs_db.clone();

        let app_handle = ctx.window_ref().app_handle().clone();
        let session_id = ctx.session_id.clone();

        let summary = tokio::task::spawn_blocking(move || {
            // 会话归属校验：staged zip 必须位于当前会话的 temp root 内
            let temp = temp_root(&app_handle, &session_id, true)?;
            let zip_path = resolve_staged_file_in_temp_root(&temp.path, &relative_path)?;

            let importer = crate::notes_exporter::NotesImporter::new_with_vfs(
                notes_database,
                file_manager,
                vfs_db,
            );
            let options = crate::notes_exporter::ImportOptions {
                conflict_strategy,
                progress_callback: None,
            };
            importer
                .import_with_options(zip_path, options)
                .map_err(|e| format!("Notes import failed: {}", e))
        })
        .await
        .map_err(|e| format!("Notes import task failed: {}", e))??;

        Ok(json!({
            "success": true,
            "conflict_strategy": conflict_strategy_raw,
            "subject_count": summary.subject_count,
            "note_count": summary.note_count,
            "attachment_count": summary.attachment_count,
            "skipped_count": summary.skipped_count,
            "overwritten_count": summary.overwritten_count,
            "hint": "导入完成：笔记与附件已写入资源库，可用 builtin-note_list / builtin-note_search 验证结果。",
        }))
    }
}

impl Default for NotesImportExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for NotesImportExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == "notes_import"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = self.execute_import(call, ctx).await;
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
                    log::warn!("{} Failed to save tool block: {}", LOG_PREFIX, e);
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
                    log::warn!("{} Failed to save tool block: {}", LOG_PREFIX, e);
                }
                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // 写资源库（笔记/附件），与项目内其他导入类写工具一致
        ToolSensitivity::Medium
    }

    fn name(&self) -> &'static str {
        "NotesImportExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_can_handle() {
        let executor = NotesImportExecutor::new();
        assert!(executor.can_handle("builtin-notes_import"));
        assert!(executor.can_handle("notes_import"));
        assert!(!executor.can_handle("builtin-notes_export"));
        assert!(!executor.can_handle("builtin-note_create"));
    }

    #[test]
    fn test_sensitivity_level() {
        let executor = NotesImportExecutor::new();
        assert_eq!(
            executor.sensitivity_level("builtin-notes_import"),
            ToolSensitivity::Medium
        );
    }
}
