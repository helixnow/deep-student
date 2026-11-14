import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';
import { annotateAutoRetry, buildRunScopedStreamEvent, isRetryableLlmError, isTransientToolError,
  PARALLEL_TOOL_CONCURRENCY, pinToolResultToBlock, planParallelSegments, runBoundedOrdered,
  TOOL_TRANSIENT_RETRY_BACKOFF_MS } from '../src/parallel-exec.ts';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const result = (success: boolean, output: unknown, error: string | null): ToolResultInfo => ({
  toolCallId: 'call_1', blockId: 'block_1', toolName: 'builtin-web_fetch', input: { url: 'https://example.com' },
  output, success, error, durationMs: 10, reasoningContent: null, thoughtSignature: null,
});
afterEach(() => vi.useRealTimers());
describe('parallel_exec_tests.rs', () => {
  it('plan_segments_groups_consecutive_parallel_calls', () => {
    expect(planParallelSegments([true, true, false, true, false, false, true])).toEqual([
      [true, { start: 0, end: 2 }], [false, { start: 2, end: 3 }], [true, { start: 3, end: 4 }],
      [false, { start: 4, end: 6 }], [true, { start: 6, end: 7 }],
    ]);
  });
  it('plan_segments_all_serial_is_single_segment', () => {
    expect(planParallelSegments([false, false, false])).toEqual([[false, { start: 0, end: 3 }]]);
  });
  it('plan_segments_all_parallel_is_single_segment', () => {
    expect(planParallelSegments([true, true, true, true])).toEqual([[true, { start: 0, end: 4 }]]);
  });
  it('plan_segments_empty_input', () => { expect(planParallelSegments([])).toEqual([]); });
  it('plan_segments_single_call', () => {
    expect(planParallelSegments([true])).toEqual([[true, { start: 0, end: 1 }]]);
    expect(planParallelSegments([false])).toEqual([[false, { start: 0, end: 1 }]]);
  });
  it('plan_segments_cover_all_indices_in_order', () => {
    const flags = [false, true, true, false, true, true, true, false];
    let expectedStart = 0;
    for (const [, range] of planParallelSegments(flags)) {
      expect(range.start).toBe(expectedStart);
      expect(range.end).toBeGreaterThan(range.start);
      expectedStart = range.end;
    }
    expect(expectedStart).toBe(flags.length);
  });
  it('bounded_ordered_preserves_input_order', async () => {
    vi.useFakeTimers();
    const work = runBoundedOrdered(Array.from({ length: 4 }, (_, i) => async () => {
      await delay(100 - i * 20); return i;
    }), PARALLEL_TOOL_CONCURRENCY);
    await vi.runAllTimersAsync();
    expect(await work).toEqual([0, 1, 2, 3]);
  });
  it('bounded_ordered_runs_concurrently', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const work = runBoundedOrdered(Array.from({ length: 4 }, () => () => delay(100)), 4);
    await vi.runAllTimersAsync(); await work;
    expect(Date.now() - start).toBeLessThan(150);
  });
  it('bounded_ordered_respects_concurrency_limit', async () => {
    vi.useFakeTimers();
    const start = Date.now();
    const work = runBoundedOrdered(Array.from({ length: 6 }, () => () => delay(100)), 2);
    await vi.runAllTimersAsync(); await work;
    expect(Date.now() - start).toBeGreaterThanOrEqual(300);
  });
  it('segmented_execution_backfills_in_original_order', async () => {
    vi.useFakeTimers();
    const segments = planParallelSegments([true, true, false, true, false]);
    expect(segments).toHaveLength(4);
    const work = (async () => {
      const results: number[] = [];
      for (const [parallel, range] of segments) {
        const indices = Array.from({ length: range.end - range.start }, (_, i) => i + range.start);
        if (parallel) results.push(...await runBoundedOrdered(indices.map(i => async () => {
          await delay(100 - i * 10); return i;
        }), PARALLEL_TOOL_CONCURRENCY));
        else results.push(...indices);
      }
      return results;
    })();
    await vi.runAllTimersAsync();
    expect(await work).toEqual([0, 1, 2, 3, 4]);
  });
  it('transient_errors_are_retryable', () => {
    for (const error of ["Tool 'web_fetch' execution timed out after 180s", 'request timeout', 'connection reset by peer',
      'Connection refused (os error 111)', 'HTTP 429 Too Many Requests', 'rate limit exceeded, retry later',
      'upstream returned 503 Service Unavailable', '502 Bad Gateway', '504 Gateway Timeout',
      '500 Internal Server Error', 'network error: dns error', 'service temporarily unavailable']) {
      expect(isTransientToolError(error), error).toBe(true);
    }
  });
  it('permanent_errors_are_not_retryable', () => {
    for (const error of ['invalid arguments: missing field `query`', 'resource not found', 'permission denied',
      '用户拒绝执行此工具', 'JSON parse error at line 3', 'file already exists', 'No executor found for tool: foo']) {
      expect(isTransientToolError(error), error).toBe(false);
    }
  });
  it('cancelled_errors_are_never_retryable', () => {
    for (const error of ['Tool execution cancelled', 'connection cancelled by user', 'request Cancelled during timeout',
      '{"code":"WORKBENCH_DISABLED","message":"off","hint":"x","retryable":false}',
      '{"code":"QBANK_CONFLICT","message":"x","retryable":false}', 'status=partial done/undone']) {
      expect(isTransientToolError(error)).toBe(false);
    }
  });
  it('retry_backoff_schedule_matches_spec', () => {
    expect(TOOL_TRANSIENT_RETRY_BACKOFF_MS).toHaveLength(2);
    expect(TOOL_TRANSIENT_RETRY_BACKOFF_MS).toEqual([500, 2000]);
    expect(PARALLEL_TOOL_CONCURRENCY).toBeGreaterThanOrEqual(4);
    expect(PARALLEL_TOOL_CONCURRENCY).toBeLessThanOrEqual(6);
  });
  it('empty_llm_response_is_retryable', () => {
    expect(isRetryableLlmError('模型返回空响应，请重试')).toBe(true);
    expect(isRetryableLlmError('provider returned an empty response')).toBe(true);
    expect(isRetryableLlmError('invalid request: missing model')).toBe(false);
  });
  it('annotate_without_retries_is_untouched', () => {
    const annotated = annotateAutoRetry(result(true, { ok: true }, null), 0);
    expect(annotated.output).toEqual({ ok: true }); expect(annotated.error).toBeNull();
  });
  it('annotate_success_after_retries_marks_output', () => {
    const annotated = annotateAutoRetry(result(true, { ok: true }, null), 2);
    expect(annotated.success).toBe(true); expect(annotated.output).toHaveProperty('_auto_retry_attempts', 2);
  });
  it('annotate_failure_after_retries_appends_error_note', () => {
    const annotated = annotateAutoRetry(result(false, {}, 'connection reset by peer'), 2);
    expect(annotated.success).toBe(false);
    expect(annotated.error).toContain('connection reset by peer'); expect(annotated.error).toContain('自动重试 2 次');
    expect(annotated.output).toHaveProperty('_auto_retry_attempts', 2);
  });
  it('annotate_non_object_output_only_touches_error', () => {
    const annotated = annotateAutoRetry(result(false, null, 'timeout'), 1);
    expect(annotated.output).toBeNull(); expect(annotated.error).toContain('自动重试 1 次');
  });
  it('retry_attempts_are_pinned_to_one_logical_block', () => {
    const failed = result(false, {}, 'connection reset');
    const success = { ...result(true, { ok: true }, null), blockId: 'executor_returned_a_different_id' };
    expect(pinToolResultToBlock(failed, 'blk_logical_retry').blockId).toBe('blk_logical_retry');
    expect(pinToolResultToBlock(success, 'blk_logical_retry').blockId).toBe('blk_logical_retry');
  });
  it('stream_hook_keys_are_unique_across_same_message_retry', () => {
    const first = buildRunScopedStreamEvent('sess_1', 'msg_1', 'run_a', 41);
    const retry = buildRunScopedStreamEvent('sess_1', 'msg_1', 'run_b', 42);
    expect(first).not.toBe(retry);
    const scope = first.slice('chat_v2_event_'.length);
    expect(scope.slice(0, scope.lastIndexOf('_var_'))).toBe('sess_1');
    expect(first.endsWith('__stream_generation__41')).toBe(true);
    expect(retry.endsWith('__stream_generation__42')).toBe(true);
  });
  it('buffered waits for the head before opening another slot', async () => {
    let release!: () => void;
    const head = new Promise<void>(resolve => { release = resolve; });
    const started: number[] = [];
    const work = runBoundedOrdered([0, 1, 2].map(i => async () => {
      started.push(i); if (i === 0) await head; return i;
    }), 2);
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual([0, 1]);
    release();
    expect(await work).toEqual([0, 1, 2]);
  });
});
