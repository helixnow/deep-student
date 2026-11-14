import type { ToolResultInfo } from '../../../../contracts/ipc/generated/L04-chat-session.ts';

export const PARALLEL_TOOL_CONCURRENCY = 4;
export const TOOL_TRANSIENT_RETRY_BACKOFF_MS = [500, 2000] as const;

export function planParallelSegments(flags: readonly boolean[]): [boolean, { start: number; end: number }][] {
  const segments: [boolean, { start: number; end: number }][] = [];
  let start = 0;
  for (let i = 1; i <= flags.length; i++) {
    if (i === flags.length || flags[i] !== flags[start]) {
      segments.push([flags[start]!, { start, end: i }]); start = i;
    }
  }
  return segments;
}

export function isTransientToolError(error: string): boolean {
  const lower = error.toLowerCase();
  if (['cancel', 'partial', 'workbench_disabled', 'workbench_unavailable', 'window_busy', 'strict_mode',
    'todo_conflict', 'qbank_conflict', '"retryable":false', '"retryable": false'].some(p => lower.includes(p))) return false;
  return ['timeout', 'timed out', 'connection', 'connect error', 'network', 'reset by peer', 'broken pipe',
    'dns error', 'temporarily unavailable', '429', 'too many requests', 'rate limit', '500 internal',
    'internal server error', '502', 'bad gateway', '503', 'service unavailable', '504', 'gateway timeout']
    .some(p => lower.includes(p));
}

export function isRetryableLlmError(error: string): boolean {
  const lower = error.replace(/[A-Z]/g, char => char.toLowerCase());
  return ['connection', 'timeout', 'timed out', 'reset', 'broken pipe', 'connect', 'temporarily unavailable',
    'status: 429', 'status: 502', 'status: 503', 'status: 504', 'empty response'].some(p => lower.includes(p))
    || error.includes('空响应');
}

export function annotateAutoRetry(info: ToolResultInfo, retries: number): ToolResultInfo {
  if (retries === 0) return info;
  if (info.output !== null && typeof info.output === 'object' && !Array.isArray(info.output)) {
    (info.output as Record<string, unknown>)._auto_retry_attempts = retries;
  }
  if (!info.success) info.error = `${info.error ?? ''} (瞬时失败已自动重试 ${retries} 次，仍未成功)`;
  return info;
}
export function pinToolResultToBlock(info: ToolResultInfo, logicalBlockId: string): ToolResultInfo {
  info.blockId = logicalBlockId; return info;
}
export function buildRunScopedStreamEvent(sessionId: string, scopeId: string, runId: string, generation: number | bigint | null): string {
  const base = `chat_v2_event_${sessionId}_var_${scopeId}_run_${runId}`;
  return generation === null ? base : `${base}__stream_generation__${generation}`;
}

/** Rust StreamExt::buffered: completed later entries occupy slots until their predecessors yield. */
export async function runBoundedOrdered<T>(operations: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const width = Math.max(limit, 1);
  const pending = new Map<number, Promise<{ ok: true; value: T } | { ok: false; error: unknown }>>();
  let next = 0;
  const results: T[] = [];
  for (let head = 0; head < operations.length; head++) {
    while (next < operations.length && pending.size < width) {
      const operation = operations[next]!;
      pending.set(next++, Promise.resolve().then(operation).then(
        value => ({ ok: true as const, value }), error => ({ ok: false as const, error }),
      ));
    }
    const result = await pending.get(head)!;
    pending.delete(head);
    if (result.ok === false) throw result.error;
    results.push(result.value);
  }
  return results;
}

export function mergeRoundResultsInCallOrder(calls: readonly { id: string }[], executed: ToolResultInfo[], synthetic: ToolResultInfo[]): ToolResultInfo[] {
  const pool: (ToolResultInfo | null)[] = [...executed, ...synthetic];
  const merged: ToolResultInfo[] = [];
  for (const call of calls) {
    const index = pool.findIndex(info => info !== null && info.toolCallId === call.id);
    if (index !== -1) { merged.push(pool[index]!); pool[index] = null; }
  }
  for (const info of pool) if (info !== null) merged.push(info);
  return merged;
}
