//! ToolPackExecutor - parallel built-in tool pack executor.
//!
//! Handles `builtin-tool_pack` calls by scheduling multiple built-in tools in
//! parallel and aggregating their results into one pack-level response.
//!
//! ## Design notes
//! - Runs at most 10 sub-tools concurrently via a semaphore.
//! - Accepts up to 20 sub-tools per pack.
//! - Delegates each sub-tool to `ToolExecutorRegistry::execute()`.
//! - Uses a default pack timeout of 300s, overridable by `timeout`.
//! - Filters sensitive tools that require user approval.
//! - Propagates cancellation with a child `CancellationToken`.
//! - Wraps each spawned task with `catch_unwind` for panic isolation.

use std::collections::HashSet;
use std::panic::AssertUnwindSafe;
use std::sync::{Arc, Weak};
use std::time::Instant;

use async_trait::async_trait;
use futures::stream::{FuturesUnordered, StreamExt};
use futures::FutureExt;
use serde_json::{json, Value};
use tokio::sync::Semaphore;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::executor_registry::ToolExecutorRegistry;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

/// ???????
const MAX_SUB_TOOLS: usize = 20;
/// ????????
const MAX_CONCURRENCY: usize = 10;
/// ?? pack ??????
const DEFAULT_PACK_TIMEOUT_SECS: u64 = 300;
/// Pack ?????????????????
const CANCEL_GRACE_PERIOD_SECS: u64 = 3;

/// ToolPackExecutor ? ?????????
pub struct ToolPackExecutor {
    /// Weak reference to ToolExecutorRegistry (avoids circular Arc dependency)
    registry_ref: Weak<ToolExecutorRegistry>,
}

impl ToolPackExecutor {
    /// Create new ToolPackExecutor
    pub fn new(registry_ref: Weak<ToolExecutorRegistry>) -> Self {
        Self { registry_ref }
    }
}

#[async_trait]
impl ToolExecutor for ToolPackExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "builtin-tool_pack" || tool_name == "tool_pack"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start = Instant::now();

        // Emit pack-level start event
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        // Upgrade weak reference
        let registry = self
            .registry_ref
            .upgrade()
            .ok_or("ToolExecutorRegistry has been dropped")?;

        // Parse tools array
        let tools = call
            .arguments
            .get("tools")
            .and_then(|v| v.as_array())
            .ok_or_else(|| {
                let msg = "tool_pack requires a 'tools' array in arguments".to_string();
                ctx.emit_tool_call_error(&msg);
                msg
            })?;

        // Parse optional pack-level timeout
        let pack_timeout_secs = match call.arguments.get("timeout").and_then(|v| v.as_u64()) {
            Some(t) if (1..=600).contains(&t) => t,
            Some(t) => {
                log::warn!(
                    "[ToolPack] timeout value {} out of range, using default {}s",
                    t,
                    DEFAULT_PACK_TIMEOUT_SECS
                );
                DEFAULT_PACK_TIMEOUT_SECS
            }
            None => DEFAULT_PACK_TIMEOUT_SECS,
        };

        // === Input Validation ===
        if tools.is_empty() {
            let msg = "tool_pack requires at least 1 sub-tool".to_string();
            ctx.emit_tool_call_error(&msg);
            return Err(msg);
        }
        if tools.len() > MAX_SUB_TOOLS {
            let msg = format!(
                "tool_pack supports at most {} sub-tools, got {}",
                MAX_SUB_TOOLS,
                tools.len()
            );
            ctx.emit_tool_call_error(&msg);
            return Err(msg);
        }

        // Parse and validate each sub-tool
        struct SubTool {
            name: String,
            args: Value,
            index: usize,
        }

        let mut sub_tools: Vec<SubTool> = Vec::with_capacity(tools.len());
        for (i, tool) in tools.iter().enumerate() {
            let name = tool.get("name").and_then(|v| v.as_str()).ok_or_else(|| {
                let msg = format!("sub-tool {} missing 'name' field", i);
                ctx.emit_tool_call_error(&msg);
                msg
            })?;

            let args = tool.get("args").cloned().unwrap_or(json!({}));

            // Self-reference check
            if name == "builtin-tool_pack" || name == "tool_pack" {
                let msg = "tool_pack cannot invoke itself (recursive call)".to_string();
                ctx.emit_tool_call_error(&msg);
                return Err(msg);
            }

            // Non-existent tool check — use has_specific_executor to avoid
            // GeneralToolExecutor catch-all matching any unknown tool name
            let effective_name = if registry.has_specific_executor(name) {
                name.to_string()
            } else if name.starts_with("builtin-") {
                let msg = format!("tool '{}' not found in tool registry", name);
                ctx.emit_tool_call_error(&msg);
                return Err(msg);
            } else {
                let prefixed = format!("builtin-{}", name);
                if !registry.has_specific_executor(&prefixed) {
                    let msg = format!("tool '{}' not found in tool registry", name);
                    ctx.emit_tool_call_error(&msg);
                    return Err(msg);
                }
                prefixed
            };

            sub_tools.push(SubTool {
                name: effective_name,
                args,
                index: i,
            });
        }

        // === Create child cancellation token ===
        let child_token = ctx
            .cancellation_token
            .as_ref()
            .map(|t| t.child_token())
            .unwrap_or_default();

        // === Execute sub-tools in parallel ===
        let semaphore = Arc::new(Semaphore::new(MAX_CONCURRENCY));
        let total = sub_tools.len();
        let expected_sub_tools: Vec<(String, Value)> = sub_tools
            .iter()
            .map(|sub| (sub.name.clone(), sub.args.clone()))
            .collect();
        let mut futs = FuturesUnordered::new();

        for sub in sub_tools {
            let sub_index = sub.index;
            let registry_clone = registry.clone();
            let sem = semaphore.clone();
            let token = child_token.clone();
            let parent_block_id = ctx.block_id.clone();
            let session_id = ctx.session_id.clone();
            let message_id = ctx.message_id.clone();
            let variant_id = ctx.variant_id.clone();
            let skill_state_version = ctx.skill_state_version;
            let round_id = ctx.round_id.clone();
            let emitter = ctx.emitter.clone();
            let canvas_note_id = ctx.canvas_note_id.clone();
            let notes_manager = ctx.notes_manager.clone();
            let tool_registry = ctx.tool_registry.clone();
            let main_db = ctx.main_db.clone();
            let anki_db = ctx.anki_db.clone();
            let window = ctx.window.clone();
            let vfs_db = ctx.vfs_db.clone();
            let vfs_lance_store = ctx.vfs_lance_store.clone();
            let llm_manager = ctx.llm_manager.clone();
            let chat_v2_db = ctx.chat_v2_db.clone();
            let question_bank_service = ctx.question_bank_service.clone();
            let skill_contents = ctx.skill_contents.clone();
            let skill_embedded_tools = ctx.skill_embedded_tools.clone();
            let rag_top_k = ctx.rag_top_k;
            let rag_enable_reranking = ctx.rag_enable_reranking;
            let pdf_processing_service = ctx.pdf_processing_service.clone();
            let memory_enabled = ctx.memory_enabled;
            let rag_enabled = ctx.rag_enabled;
            let web_search_enabled = ctx.web_search_enabled;

            let handle = tokio::spawn(async move {
                let sub_start = Instant::now();
                let sub_block_id = format!("{}-tool_pack-{}", parent_block_id, sub.index);
                let sub_call_id = format!("{}-tp-{}", parent_block_id, sub.index);

                // Cancellation check (early exit)
                if token.is_cancelled() {
                    return ToolResultInfo::cancelled(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name,
                        sub.args,
                        0,
                    );
                }

                // Acquire semaphore permit with cancellation-aware select
                let _permit = tokio::select! {
                    result = sem.acquire() => {
                        match result {
                            Ok(permit) => permit,
                            Err(e) => {
                                log::error!("[ToolPack] Semaphore acquire error for '{}': {}", sub.name, e);
                                return ToolResultInfo::failure(
                                    Some(sub_call_id),
                                    Some(sub_block_id),
                                    sub.name,
                                    sub.args,
                                    format!("Concurrency limit error: {}", e),
                                    0,
                                );
                            }
                        }
                    }
                    _ = token.cancelled() => {
                        return ToolResultInfo::cancelled(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name,
                            sub.args,
                            0,
                        );
                    }
                };

                // Create sub-tool call
                let sub_call =
                    ToolCall::new(sub_call_id.clone(), sub.name.clone(), sub.args.clone());

                // Create sub-context
                let sub_ctx = ExecutionContext {
                    session_id,
                    message_id,
                    variant_id,
                    skill_state_version,
                    round_id,
                    block_id: sub_block_id.clone(),
                    emitter,
                    canvas_note_id,
                    notes_manager,
                    tool_registry,
                    main_db,
                    anki_db,
                    window,
                    vfs_db,
                    vfs_lance_store,
                    llm_manager,
                    chat_v2_db,
                    question_bank_service,
                    skill_contents,
                    skill_embedded_tools,
                    cancellation_token: Some(token.clone()),
                    rag_top_k,
                    rag_enable_reranking,
                    pdf_processing_service,
                    memory_enabled,
                    rag_enabled,
                    web_search_enabled,
                };

                // === Security preflight checks (mirrors pipeline execute_single_tool) ===
                // Feature flag checks
                let sub_short_name = sub.name.strip_prefix("builtin-").unwrap_or(&sub.name);
                let is_memory_tool = sub_short_name.starts_with("memory_");
                let is_rag_tool = sub_short_name.starts_with("rag_");
                let is_web_search_tool = sub_short_name == "web_search";

                if is_memory_tool && !memory_enabled {
                    return ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name,
                        sub.args,
                        "memory function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                }
                if is_rag_tool && !rag_enabled {
                    return ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name,
                        sub.args,
                        "RAG function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                }
                if is_web_search_tool && !web_search_enabled {
                    return ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name,
                        sub.args,
                        "WebSearch function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                }

                // Sensitivity check — block high-sensitivity tools that require user approval
                // (approval dialogs cannot work inside parallel async spawns)
                if let Some(sensitivity) = registry_clone.get_sensitivity(&sub.name) {
                    if sensitivity != ToolSensitivity::Low {
                        log::warn!(
                            "[ToolPack] Sub-tool '{}' has sensitivity {:?} — blocking in parallel context",
                            sub.name,
                            sensitivity
                        );
                        return ToolResultInfo::failure(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name.clone(),
                            sub.args,
                            format!(
                                "Tool '{}' requires user approval (sensitivity: {:?}) and cannot be executed inside tool_pack",
                                sub.name,
                                sensitivity
                            ),
                            0,
                        );
                    }
                }

                // Execute with catch_unwind to prevent panic propagation
                let result =
                    AssertUnwindSafe(async { registry_clone.execute(&sub_call, &sub_ctx).await })
                        .catch_unwind()
                        .await;

                let elapsed = sub_start.elapsed().as_millis() as u64;

                match result {
                    Ok(Ok(tool_result)) => tool_result,
                    Ok(Err(err_msg)) => ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name,
                        sub.args,
                        err_msg,
                        elapsed,
                    ),
                    Err(panic_info) => {
                        let panic_msg = if let Some(s) = panic_info.downcast_ref::<String>() {
                            s.clone()
                        } else if let Some(s) = panic_info.downcast_ref::<&str>() {
                            s.to_string()
                        } else {
                            "task panicked".to_string()
                        };
                        log::error!("[ToolPack] Sub-tool '{}' panicked: {}", sub.name, panic_msg);
                        ToolResultInfo::failure(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name,
                            sub.args,
                            format!("task panicked: {}", panic_msg),
                            elapsed,
                        )
                    }
                }
            });

            futs.push(async move { (sub_index, handle.await) });
        }

        // Wait for all sub-tools with pack-level timeout
        let pack_timeout_duration = Duration::from_secs(pack_timeout_secs);
        let mut results: Vec<ToolResultInfo> = Vec::with_capacity(total);
        let mut completed_indices: HashSet<usize> = HashSet::with_capacity(total);
        let pack_deadline = tokio::time::sleep(pack_timeout_duration);
        tokio::pin!(pack_deadline);

        loop {
            tokio::select! {
                Some((sub_index, join_result)) = futs.next() => {
                    match join_result {
                        Ok(tool_result) => {
                            completed_indices.insert(sub_index);
                            results.push(tool_result);
                        }
                        Err(join_err) => {
                            log::error!("[ToolPack] Task join error: {}", join_err);
                            completed_indices.insert(sub_index);
                            let (tool_name, args) = expected_sub_tools
                                .get(sub_index)
                                .cloned()
                                .unwrap_or_else(|| ("unknown".to_string(), json!(null)));
                            results.push(ToolResultInfo::failure(
                                Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                                Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                                tool_name,
                                args,
                                format!("task join error: {}", join_err),
                                0,
                            ));
                        }
                    }
                    if completed_indices.len() == total {
                        break;
                    }
                }
                _ = &mut pack_deadline => {
                    log::warn!(
                        "[ToolPack] Pack timeout after {}s, cancelling {} remaining sub-tools",
                        pack_timeout_secs,
                        total - results.len()
                    );
                    child_token.cancel();
                    // Grace period: wait for running sub-tools to exit
                    let grace = Duration::from_secs(CANCEL_GRACE_PERIOD_SECS);
                    while let Ok(Some((sub_index, join_result))) = timeout(grace, futs.next()).await {
                        match join_result {
                            Ok(tool_result) => {
                                completed_indices.insert(sub_index);
                                results.push(tool_result);
                            }
                            Err(join_err) => {
                                completed_indices.insert(sub_index);
                                let (tool_name, args) = expected_sub_tools
                                    .get(sub_index)
                                    .cloned()
                                    .unwrap_or_else(|| ("unknown".to_string(), json!(null)));
                                results.push(ToolResultInfo::failure(
                                    Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                                    Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                                    tool_name,
                                    args,
                                    format!("task join error: {}", join_err),
                                    0,
                                ));
                            }
                        }
                    }
                    for (sub_index, (tool_name, args)) in expected_sub_tools.iter().enumerate() {
                        if completed_indices.contains(&sub_index) {
                            continue;
                        }
                        results.push(ToolResultInfo::failure(
                            Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                            Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                            tool_name.clone(),
                            args.clone(),
                            "tool_pack timeout: sub-tool did not complete within grace period".to_string(),
                            pack_timeout_secs * 1000,
                        ));
                        completed_indices.insert(sub_index);
                    }
                    break;
                }
            }
        }

        // === Aggregate Results ===
        let total_ms = start.elapsed().as_millis() as u64;
        let succeeded = results.iter().filter(|r| r.success).count();
        let failed = results.len() - succeeded;

        let results_json: Vec<Value> = results
            .iter()
            .map(|r| {
                json!({
                    "tool_name": r.tool_name,
                    "success": r.success,
                    "output": r.output,
                    "error": r.error,
                    "duration_ms": r.duration_ms,
                    "block_id": r.block_id,
                })
            })
            .collect();

        let output = json!({
            "total_ms": total_ms,
            "succeeded": succeeded,
            "failed": failed,
            "results": results_json,
        });

        // Emit pack-level end event
        ctx.emit_tool_call_end(Some(json!({
            "result": output,
            "durationMs": total_ms,
        })));

        log::info!(
            "[ToolPack] Completed: {}/{} succeeded, {}ms total",
            succeeded,
            total,
            total_ms
        );

        Ok(ToolResultInfo::success(
            Some(call.id.clone()),
            Some(ctx.block_id.clone()),
            call.name.clone(),
            call.arguments.clone(),
            output,
            total_ms,
        ))
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "ToolPackExecutor"
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_can_handle() {
        let executor = ToolPackExecutor::new(Weak::new());
        assert!(executor.can_handle("builtin-tool_pack"));
        assert!(executor.can_handle("tool_pack"));
        assert!(!executor.can_handle("builtin-note_read"));
        assert!(!executor.can_handle("other_tool"));
    }

    #[test]
    fn test_executor_name() {
        let executor = ToolPackExecutor::new(Weak::new());
        assert_eq!(executor.name(), "ToolPackExecutor");
    }

    #[test]
    fn test_constants() {
        assert_eq!(MAX_SUB_TOOLS, 20);
        assert_eq!(MAX_CONCURRENCY, 10);
        assert_eq!(DEFAULT_PACK_TIMEOUT_SECS, 300);
    }
}
