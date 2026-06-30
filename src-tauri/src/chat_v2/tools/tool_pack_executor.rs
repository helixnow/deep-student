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

fn create_sub_context(
    parent: &ExecutionContext,
    block_id: String,
    token: CancellationToken,
) -> ExecutionContext {
    ExecutionContext {
        session_id: parent.session_id.clone(),
        message_id: parent.message_id.clone(),
        variant_id: parent.variant_id.clone(),
        skill_state_version: parent.skill_state_version,
        round_id: parent.round_id.clone(),
        block_id,
        emitter: parent.emitter.clone(),
        canvas_note_id: parent.canvas_note_id.clone(),
        notes_manager: parent.notes_manager.clone(),
        tool_registry: parent.tool_registry.clone(),
        main_db: parent.main_db.clone(),
        anki_db: parent.anki_db.clone(),
        window: parent.window.clone(),
        vfs_db: parent.vfs_db.clone(),
        vfs_lance_store: parent.vfs_lance_store.clone(),
        llm_manager: parent.llm_manager.clone(),
        chat_v2_db: parent.chat_v2_db.clone(),
        question_bank_service: parent.question_bank_service.clone(),
        skill_contents: parent.skill_contents.clone(),
        skill_embedded_tools: parent.skill_embedded_tools.clone(),
        cancellation_token: Some(token),
        rag_top_k: parent.rag_top_k,
        rag_enable_reranking: parent.rag_enable_reranking,
        pdf_processing_service: parent.pdf_processing_service.clone(),
        memory_enabled: parent.memory_enabled,
        rag_enabled: parent.rag_enabled,
        web_search_enabled: parent.web_search_enabled,
    }
}

fn finalize_synthetic_sub_result(
    ctx: &ExecutionContext,
    result: &ToolResultInfo,
    emit_start: bool,
) {
    if emit_start {
        ctx.emit_tool_call_start(
            &result.tool_name,
            result.input.clone(),
            result.tool_call_id.as_deref(),
        );
    }

    if let Some(error) = result.error.as_deref() {
        ctx.emit_tool_call_error(error);
    } else {
        ctx.emit_tool_call_end(Some(json!({
            "result": result.output.clone(),
            "durationMs": result.duration_ms.unwrap_or(0),
        })));
    }

    if let Err(e) = ctx.save_tool_block(result) {
        log::warn!("[ToolPack] Failed to save synthetic sub-tool result: {}", e);
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

            if registry.is_no_timeout_tool(&effective_name) {
                let msg = format!(
                    "tool_pack cannot execute blocking/no-timeout tool '{}'",
                    effective_name
                );
                ctx.emit_tool_call_error(&msg);
                return Err(msg);
            }

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
            let sub_block_id = format!("{}-tool_pack-{}", ctx.block_id, sub.index);
            let sub_call_id = format!("{}-tp-{}", ctx.block_id, sub.index);
            let sub_ctx = create_sub_context(ctx, sub_block_id.clone(), token.clone());

            let handle = tokio::spawn(async move {
                let sub_start = Instant::now();

                // Create sub-tool call/context before preflight so synthetic failures
                // can close and persist the exact sub-tool block.
                let sub_call =
                    ToolCall::new(sub_call_id.clone(), sub.name.clone(), sub.args.clone());

                // Cancellation check (early exit)
                if token.is_cancelled() {
                    let result = ToolResultInfo::cancelled(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name.clone(),
                        sub.args.clone(),
                        0,
                    );
                    finalize_synthetic_sub_result(&sub_ctx, &result, true);
                    return result;
                }

                // Acquire semaphore permit with cancellation-aware select
                let _permit = tokio::select! {
                    result = sem.acquire() => {
                        match result {
                            Ok(permit) => permit,
                            Err(e) => {
                                log::error!("[ToolPack] Semaphore acquire error for '{}': {}", sub.name, e);
                                let result = ToolResultInfo::failure(
                                    Some(sub_call_id),
                                    Some(sub_block_id),
                                    sub.name.clone(),
                                    sub.args.clone(),
                                    format!("Concurrency limit error: {}", e),
                                    0,
                                );
                                finalize_synthetic_sub_result(&sub_ctx, &result, true);
                                return result;
                            }
                        }
                    }
                    _ = token.cancelled() => {
                        let result = ToolResultInfo::cancelled(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name.clone(),
                            sub.args.clone(),
                            0,
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, true);
                        return result;
                    }
                };

                // === Security preflight checks (mirrors pipeline execute_single_tool) ===
                // Feature flag checks
                let sub_short_name = sub.name.strip_prefix("builtin-").unwrap_or(&sub.name);
                let is_memory_tool = sub_short_name.starts_with("memory_");
                let is_rag_tool = sub_short_name.starts_with("rag_");
                let is_web_search_tool = sub_short_name == "web_search";

                if is_memory_tool && !sub_ctx.memory_enabled {
                    let result = ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name.clone(),
                        sub.args.clone(),
                        "memory function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                    finalize_synthetic_sub_result(&sub_ctx, &result, true);
                    return result;
                }
                if is_rag_tool && !sub_ctx.rag_enabled {
                    let result = ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name.clone(),
                        sub.args.clone(),
                        "RAG function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                    finalize_synthetic_sub_result(&sub_ctx, &result, true);
                    return result;
                }
                if is_web_search_tool && !sub_ctx.web_search_enabled {
                    let result = ToolResultInfo::failure(
                        Some(sub_call_id),
                        Some(sub_block_id),
                        sub.name.clone(),
                        sub.args.clone(),
                        "WebSearch function disabled, sub-tool blocked".to_string(),
                        0,
                    );
                    finalize_synthetic_sub_result(&sub_ctx, &result, true);
                    return result;
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
                        let result = ToolResultInfo::failure(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name.clone(),
                            sub.args.clone(),
                            format!(
                                "Tool '{}' requires user approval (sensitivity: {:?}) and cannot be executed inside tool_pack",
                                sub.name,
                                sensitivity
                            ),
                            0,
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, true);
                        return result;
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
                    Ok(Err(err_msg)) => {
                        let result = ToolResultInfo::failure(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name,
                            sub.args,
                            err_msg,
                            elapsed,
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, false);
                        result
                    }
                    Err(panic_info) => {
                        let panic_msg = if let Some(s) = panic_info.downcast_ref::<String>() {
                            s.clone()
                        } else if let Some(s) = panic_info.downcast_ref::<&str>() {
                            s.to_string()
                        } else {
                            "task panicked".to_string()
                        };
                        log::error!("[ToolPack] Sub-tool '{}' panicked: {}", sub.name, panic_msg);
                        let result = ToolResultInfo::failure(
                            Some(sub_call_id),
                            Some(sub_block_id),
                            sub.name,
                            sub.args,
                            format!("task panicked: {}", panic_msg),
                            elapsed,
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, false);
                        result
                    }
                }
            });

            futs.push(async move { (sub_index, handle.await) });
        }

        // Wait for all sub-tools with pack-level timeout
        let pack_timeout_duration = Duration::from_secs(pack_timeout_secs);
        let mut results: Vec<(usize, ToolResultInfo)> = Vec::with_capacity(total);
        let mut completed_indices: HashSet<usize> = HashSet::with_capacity(total);
        let pack_deadline = tokio::time::sleep(pack_timeout_duration);
        tokio::pin!(pack_deadline);

        loop {
            tokio::select! {
                Some((sub_index, join_result)) = futs.next() => {
                    match join_result {
                        Ok(tool_result) => {
                            completed_indices.insert(sub_index);
                            results.push((sub_index, tool_result));
                        }
                        Err(join_err) => {
                            log::error!("[ToolPack] Task join error: {}", join_err);
                            completed_indices.insert(sub_index);
                            let (tool_name, args) = expected_sub_tools
                                .get(sub_index)
                                .cloned()
                                .unwrap_or_else(|| ("unknown".to_string(), json!(null)));
                            let result = ToolResultInfo::failure(
                                Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                                Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                                tool_name,
                                args,
                                format!("task join error: {}", join_err),
                                0,
                            );
                            let sub_ctx = create_sub_context(
                                ctx,
                                format!("{}-tool_pack-{}", ctx.block_id, sub_index),
                                child_token.clone(),
                            );
                            finalize_synthetic_sub_result(&sub_ctx, &result, true);
                            results.push((sub_index, result));
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
                        total - completed_indices.len()
                    );
                    child_token.cancel();
                    // Grace period: wait for running sub-tools to exit
                    let grace = Duration::from_secs(CANCEL_GRACE_PERIOD_SECS);
                    while let Ok(Some((sub_index, join_result))) = timeout(grace, futs.next()).await {
                        match join_result {
                            Ok(tool_result) => {
                                completed_indices.insert(sub_index);
                                results.push((sub_index, tool_result));
                            }
                            Err(join_err) => {
                                completed_indices.insert(sub_index);
                                let (tool_name, args) = expected_sub_tools
                                    .get(sub_index)
                                    .cloned()
                                    .unwrap_or_else(|| ("unknown".to_string(), json!(null)));
                                let result = ToolResultInfo::failure(
                                    Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                                    Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                                    tool_name,
                                    args,
                                    format!("task join error: {}", join_err),
                                    0,
                                );
                                let sub_ctx = create_sub_context(
                                    ctx,
                                    format!("{}-tool_pack-{}", ctx.block_id, sub_index),
                                    child_token.clone(),
                                );
                                finalize_synthetic_sub_result(&sub_ctx, &result, true);
                                results.push((sub_index, result));
                            }
                        }
                    }
                    for (sub_index, (tool_name, args)) in expected_sub_tools.iter().enumerate() {
                        if completed_indices.contains(&sub_index) {
                            continue;
                        }
                        let result = ToolResultInfo::failure(
                            Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                            Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                            tool_name.clone(),
                            args.clone(),
                            "tool_pack timeout: sub-tool did not complete within grace period".to_string(),
                            pack_timeout_secs * 1000,
                        );
                        let sub_ctx = create_sub_context(
                            ctx,
                            format!("{}-tool_pack-{}", ctx.block_id, sub_index),
                            child_token.clone(),
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, true);
                        results.push((sub_index, result));
                        completed_indices.insert(sub_index);
                    }
                    break;
                }
                _ = child_token.cancelled() => {
                    log::info!("[ToolPack] Pack cancelled, draining completed sub-tools");
                    let grace = Duration::from_secs(CANCEL_GRACE_PERIOD_SECS);
                    while let Ok(Some((sub_index, join_result))) = timeout(grace, futs.next()).await {
                        match join_result {
                            Ok(tool_result) => {
                                completed_indices.insert(sub_index);
                                results.push((sub_index, tool_result));
                            }
                            Err(join_err) => {
                                completed_indices.insert(sub_index);
                                let (tool_name, args) = expected_sub_tools
                                    .get(sub_index)
                                    .cloned()
                                    .unwrap_or_else(|| ("unknown".to_string(), json!(null)));
                                let result = ToolResultInfo::failure(
                                    Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                                    Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                                    tool_name,
                                    args,
                                    format!("task join error: {}", join_err),
                                    0,
                                );
                                let sub_ctx = create_sub_context(
                                    ctx,
                                    format!("{}-tool_pack-{}", ctx.block_id, sub_index),
                                    child_token.clone(),
                                );
                                finalize_synthetic_sub_result(&sub_ctx, &result, true);
                                results.push((sub_index, result));
                            }
                        }
                    }
                    for (sub_index, (tool_name, args)) in expected_sub_tools.iter().enumerate() {
                        if completed_indices.contains(&sub_index) {
                            continue;
                        }
                        let result = ToolResultInfo::cancelled(
                            Some(format!("{}-tp-{}", ctx.block_id, sub_index)),
                            Some(format!("{}-tool_pack-{}", ctx.block_id, sub_index)),
                            tool_name.clone(),
                            args.clone(),
                            start.elapsed().as_millis() as u64,
                        );
                        let sub_ctx = create_sub_context(
                            ctx,
                            format!("{}-tool_pack-{}", ctx.block_id, sub_index),
                            child_token.clone(),
                        );
                        finalize_synthetic_sub_result(&sub_ctx, &result, true);
                        results.push((sub_index, result));
                        completed_indices.insert(sub_index);
                    }
                    break;
                }
            }
        }

        // === Aggregate Results ===
        results.sort_by_key(|(index, _)| *index);
        let total_ms = start.elapsed().as_millis() as u64;
        let succeeded = results.iter().filter(|(_, r)| r.success).count();
        let failed = results.len() - succeeded;

        let results_json: Vec<Value> = results
            .iter()
            .map(|(index, r)| {
                json!({
                    "index": index,
                    "tool_call_id": r.tool_call_id,
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
