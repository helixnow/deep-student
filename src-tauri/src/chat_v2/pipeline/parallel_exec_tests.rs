//! 🆕 2026-07 并行工具调用改造的单元测试
//!
//! 覆盖范围（对应 `pipeline/tool_loop.rs` 的纯函数与执行组合子）：
//! 1. 并发分段计划 `plan_parallel_segments`（含 Serial 混排）
//! 2. 有界并发 + 按原始顺序回填 `run_bounded_ordered`
//! 3. 瞬时错误重试判定 `is_transient_tool_error` 与退避参数
//! 4. 重试标注 `annotate_auto_retry`
//! 5. 只读 executor 的 `concurrency_class` 覆写声明
//!
//! 本模块由 `pipeline.rs` 的 `#[cfg(test)] mod parallel_exec_tests;` 声明，
//! 仅在测试构建时编译。

use std::time::Duration;

use serde_json::json;

use super::tool_loop::{
    annotate_auto_retry, build_run_scoped_stream_event, is_transient_tool_error,
    pin_tool_result_to_block, plan_parallel_segments, run_bounded_ordered,
    PARALLEL_TOOL_CONCURRENCY, TOOL_TRANSIENT_RETRY_BACKOFF_MS,
};
use crate::chat_v2::types::ToolResultInfo;

// ============================================================================
// 1. 并发分段计划
// ============================================================================

#[test]
fn plan_segments_groups_consecutive_parallel_calls() {
    // R R S R S S R（R=可并行，S=串行）→ 5 段
    let flags = [true, true, false, true, false, false, true];
    let segments = plan_parallel_segments(&flags);
    assert_eq!(
        segments,
        vec![
            (true, 0..2),
            (false, 2..3),
            (true, 3..4),
            (false, 4..6),
            (true, 6..7),
        ]
    );
}

#[test]
fn plan_segments_all_serial_is_single_segment() {
    let segments = plan_parallel_segments(&[false, false, false]);
    assert_eq!(segments, vec![(false, 0..3)]);
}

#[test]
fn plan_segments_all_parallel_is_single_segment() {
    let segments = plan_parallel_segments(&[true, true, true, true]);
    assert_eq!(segments, vec![(true, 0..4)]);
}

#[test]
fn plan_segments_empty_input() {
    assert!(plan_parallel_segments(&[]).is_empty());
}

#[test]
fn plan_segments_single_call() {
    assert_eq!(plan_parallel_segments(&[true]), vec![(true, 0..1)]);
    assert_eq!(plan_parallel_segments(&[false]), vec![(false, 0..1)]);
}

/// 分段必须首尾相接、按原顺序覆盖全部下标 —— 这是「结果按原始顺序回填」的前提
#[test]
fn plan_segments_cover_all_indices_in_order() {
    let flags = [false, true, true, false, true, true, true, false];
    let segments = plan_parallel_segments(&flags);
    let mut expected_start = 0usize;
    for (_, range) in &segments {
        assert_eq!(range.start, expected_start, "segments must be contiguous");
        assert!(range.end > range.start, "segments must be non-empty");
        expected_start = range.end;
    }
    assert_eq!(expected_start, flags.len(), "segments must cover all calls");
}

// ============================================================================
// 2. 有界并发 + 顺序回填
// ============================================================================

/// 后完成的 future 不能插队：即使后面的任务先完成，结果仍按输入顺序回填
#[tokio::test(start_paused = true)]
async fn bounded_ordered_preserves_input_order() {
    // 睡眠时间递减 → 输入靠后的 future 先完成
    let futs: Vec<_> = (0..4u64)
        .map(|i| async move {
            tokio::time::sleep(Duration::from_millis(100 - i * 20)).await;
            i
        })
        .collect();
    let results = run_bounded_ordered(futs, PARALLEL_TOOL_CONCURRENCY).await;
    assert_eq!(results, vec![0, 1, 2, 3]);
}

/// 并行性验证：4 个各睡 100ms 的任务在并发度 4 下总耗时 ≈ 100ms（虚拟时钟，确定性）
#[tokio::test(start_paused = true)]
async fn bounded_ordered_runs_concurrently() {
    let start = tokio::time::Instant::now();
    let futs: Vec<_> = (0..4)
        .map(|_| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
        })
        .collect();
    run_bounded_ordered(futs, 4).await;
    let elapsed = start.elapsed();
    assert!(
        elapsed < Duration::from_millis(150),
        "expected concurrent execution (~100ms), got {:?}",
        elapsed
    );
}

/// 并发度上限验证：6 个各睡 100ms 的任务在并发度 2 下需要 3 批 ≈ 300ms
#[tokio::test(start_paused = true)]
async fn bounded_ordered_respects_concurrency_limit() {
    let start = tokio::time::Instant::now();
    let futs: Vec<_> = (0..6)
        .map(|_| async {
            tokio::time::sleep(Duration::from_millis(100)).await;
        })
        .collect();
    run_bounded_ordered(futs, 2).await;
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(300),
        "concurrency limit not enforced, got {:?}",
        elapsed
    );
}

/// Serial 混排端到端语义模拟：并行段并发执行、串行段顺序执行，
/// 最终结果向量与原始调用顺序一致
#[tokio::test(start_paused = true)]
async fn segmented_execution_backfills_in_original_order() {
    // [R, R, W, R, W]：R=只读可并行，W=写串行
    let flags = [true, true, false, true, false];
    let segments = plan_parallel_segments(&flags);
    assert_eq!(segments.len(), 4);

    let mut results: Vec<usize> = Vec::new();
    for (is_parallel, range) in segments {
        if is_parallel {
            let futs: Vec<_> = range
                .map(|i| async move {
                    // 段内靠后的调用先完成，验证保序回填
                    tokio::time::sleep(Duration::from_millis((100 - i * 10) as u64)).await;
                    i
                })
                .collect();
            results.extend(run_bounded_ordered(futs, PARALLEL_TOOL_CONCURRENCY).await);
        } else {
            for i in range {
                results.push(i);
            }
        }
    }
    assert_eq!(results, vec![0, 1, 2, 3, 4]);
}

// ============================================================================
// 3. 瞬时错误重试判定
// ============================================================================

#[test]
fn transient_errors_are_retryable() {
    let cases = [
        "Tool 'web_fetch' execution timed out after 180s",
        "request timeout",
        "connection reset by peer",
        "Connection refused (os error 111)",
        "HTTP 429 Too Many Requests",
        "rate limit exceeded, retry later",
        "upstream returned 503 Service Unavailable",
        "502 Bad Gateway",
        "504 Gateway Timeout",
        "500 Internal Server Error",
        "network error: dns error",
        "service temporarily unavailable",
    ];
    for err in cases {
        assert!(is_transient_tool_error(err), "should be transient: {err}");
    }
}

#[test]
fn permanent_errors_are_not_retryable() {
    let cases = [
        "invalid arguments: missing field `query`",
        "resource not found",
        "permission denied",
        "用户拒绝执行此工具",
        "JSON parse error at line 3",
        "file already exists",
        "No executor found for tool: foo",
    ];
    for err in cases {
        assert!(
            !is_transient_tool_error(err),
            "should NOT be transient: {err}"
        );
    }
}

/// 取消绝不重试 —— 即使错误信息同时包含瞬时特征关键字
#[test]
fn cancelled_errors_are_never_retryable() {
    assert!(!is_transient_tool_error("Tool execution cancelled"));
    assert!(!is_transient_tool_error("connection cancelled by user"));
    assert!(!is_transient_tool_error("request Cancelled during timeout"));
    // ACR R2-01：闸门 / 冲突 / partial 亦不重试
    assert!(!is_transient_tool_error(
        r#"{"code":"WORKBENCH_DISABLED","message":"off","hint":"x","retryable":false}"#
    ));
    assert!(!is_transient_tool_error(
        r#"{"code":"QBANK_CONFLICT","message":"x","retryable":false}"#
    ));
    assert!(!is_transient_tool_error("status=partial done/undone"));
}

/// 退避参数：最多重试 2 次、指数退避 500ms → 2s
#[test]
fn retry_backoff_schedule_matches_spec() {
    assert_eq!(TOOL_TRANSIENT_RETRY_BACKOFF_MS.len(), 2);
    assert_eq!(TOOL_TRANSIENT_RETRY_BACKOFF_MS, [500, 2000]);
    // 并发度必须落在 4-6 的规格区间
    assert!((4..=6).contains(&PARALLEL_TOOL_CONCURRENCY));
}

// ============================================================================
// 4. 重试标注
// ============================================================================

fn make_result(success: bool, output: serde_json::Value, error: Option<&str>) -> ToolResultInfo {
    ToolResultInfo {
        tool_call_id: Some("call_1".to_string()),
        block_id: Some("block_1".to_string()),
        tool_name: "builtin-web_fetch".to_string(),
        input: json!({"url": "https://example.com"}),
        output,
        success,
        error: error.map(|s| s.to_string()),
        duration_ms: Some(10),
        reasoning_content: None,
        thought_signature: None,
    }
}

#[test]
fn annotate_without_retries_is_untouched() {
    let info = make_result(true, json!({"ok": true}), None);
    let annotated = annotate_auto_retry(info, 0);
    assert_eq!(annotated.output, json!({"ok": true}));
    assert!(annotated.error.is_none());
}

#[test]
fn annotate_success_after_retries_marks_output() {
    let info = make_result(true, json!({"ok": true}), None);
    let annotated = annotate_auto_retry(info, 2);
    assert!(annotated.success);
    assert_eq!(
        annotated.output.get("_auto_retry_attempts"),
        Some(&json!(2))
    );
}

#[test]
fn annotate_failure_after_retries_appends_error_note() {
    let info = make_result(false, json!({}), Some("connection reset by peer"));
    let annotated = annotate_auto_retry(info, 2);
    assert!(!annotated.success);
    let err = annotated.error.expect("error must be present");
    assert!(err.contains("connection reset by peer"));
    assert!(
        err.contains("自动重试 2 次"),
        "error should note retries: {err}"
    );
    assert_eq!(
        annotated.output.get("_auto_retry_attempts"),
        Some(&json!(2))
    );
}

/// 非对象输出（如 null）不插入标注字段，但错误信息仍注明
#[test]
fn annotate_non_object_output_only_touches_error() {
    let info = make_result(false, serde_json::Value::Null, Some("timeout"));
    let annotated = annotate_auto_retry(info, 1);
    assert!(annotated.output.is_null());
    assert!(annotated.error.expect("error").contains("自动重试 1 次"));
}

#[test]
fn retry_attempts_are_pinned_to_one_logical_block() {
    let failed_attempt = make_result(false, json!({}), Some("connection reset"));
    let mut successful_attempt = make_result(true, json!({"ok": true}), None);
    successful_attempt.block_id = Some("executor_returned_a_different_id".to_string());

    let failed = pin_tool_result_to_block(failed_attempt, "blk_logical_retry");
    let succeeded = pin_tool_result_to_block(successful_attempt, "blk_logical_retry");

    assert_eq!(failed.block_id.as_deref(), Some("blk_logical_retry"));
    assert_eq!(succeeded.block_id.as_deref(), Some("blk_logical_retry"));
}

#[test]
fn stream_hook_keys_are_unique_across_same_message_retry() {
    let first = build_run_scoped_stream_event("sess_1", "msg_1", "run_a", Some(41));
    let retry = build_run_scoped_stream_event("sess_1", "msg_1", "run_b", Some(42));

    assert_ne!(first, retry, "old async cleanup must target a distinct key");
    assert_eq!(
        first
            .strip_prefix("chat_v2_event_")
            .and_then(|scope| scope.rsplit_once("_var_").map(|(session, _)| session)),
        Some("sess_1"),
        "run scoping must preserve reconnect session routing"
    );
    assert!(first.ends_with("__stream_generation__41"));
    assert!(retry.ends_with("__stream_generation__42"));
}

// ============================================================================
// 5. 只读 executor 的 concurrency_class 覆写声明
// ============================================================================

#[test]
fn read_only_executors_declare_read_only_class() {
    use crate::chat_v2::tools::executor::{ToolConcurrency, ToolExecutor};
    use crate::chat_v2::tools::{
        AcademicSearchExecutor, BuiltinResourceExecutor, BuiltinRetrievalExecutor, FetchExecutor,
        MemoryToolExecutor, SkillsExecutor,
    };

    // 全只读 executor
    let retrieval = BuiltinRetrievalExecutor::new();
    assert_eq!(
        retrieval.concurrency_class("builtin-rag_search"),
        ToolConcurrency::ReadOnly
    );
    let fetch = FetchExecutor::new();
    assert_eq!(
        fetch.concurrency_class("builtin-web_fetch"),
        ToolConcurrency::ReadOnly
    );
    let academic = AcademicSearchExecutor::new();
    assert_eq!(
        academic.concurrency_class("builtin-arxiv_search"),
        ToolConcurrency::ReadOnly
    );

    // 混合读写 executor：按工具名细分
    let resource = BuiltinResourceExecutor::new();
    assert_eq!(
        resource.concurrency_class("builtin-resource_read"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        resource.concurrency_class("builtin-folder_list"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        resource.concurrency_class("builtin-mindmap_create"),
        ToolConcurrency::Serial
    );
    let memory = MemoryToolExecutor::new();
    assert_eq!(
        memory.concurrency_class("builtin-memory_search"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_read"),
        ToolConcurrency::ReadOnly
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_write"),
        ToolConcurrency::Serial
    );
    assert_eq!(
        memory.concurrency_class("builtin-memory_delete"),
        ToolConcurrency::Serial
    );

    // 未覆写的 executor 沿用默认 Serial（load_skills 会改会话技能状态，非只读）
    let skills = SkillsExecutor::new();
    assert_eq!(
        skills.concurrency_class("builtin-load_skills"),
        ToolConcurrency::Serial
    );
}
