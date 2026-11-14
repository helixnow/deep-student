// Rust: chatanki_executor.rs:198–234, 7425–7460, 14138 pipeline/stale block timing.
import { parseRfc3339 } from '../../../platform/time/index.ts';

// ============================================================================
// Timeouts / stale blocks (chatanki_executor.rs:198–234, 7425–7460, 14138)
// ============================================================================

export const PIPELINE_IDLE_TIMEOUT_MS = 60 * 10 * 1000;
export const PIPELINE_MAX_TOTAL_DURATION_MS = 60 * 60 * 6 * 1000;
export const STALE_RUNNING_ANKI_BLOCK_AFTER_MS = 2 * 60 * 1000;

export type PipelineTimeoutKind = 'idle' | 'total';

/** 总时长上限优先，其次空闲超时（调用方在有进度时重置空闲时钟）。 */
export function decidePipelineTimeout(
  idleElapsedMs: number, totalElapsedMs: number,
): PipelineTimeoutKind | null {
  if (totalElapsedMs > PIPELINE_MAX_TOTAL_DURATION_MS) return 'total';
  if (idleElapsedMs > PIPELINE_IDLE_TIMEOUT_MS) return 'idle';
  return null;
}

/** 超时截止时仍未见到块：极短 timeout 下 not_found 多半是误报，返回 timeout。 */
export function decideWaitTimeoutStatus(
  blockEverFound: boolean, documentWaitAvailable: boolean, timeoutMs: number,
): { status: 'timeout' | 'not_found'; error: string | null } {
  if (!blockEverFound && !documentWaitAvailable) {
    if (timeoutMs < 5_000) {
      return { status: 'timeout', error: 'blocks.ankiCards.errors.waitTimeout' };
    }
    return { status: 'not_found', error: 'blocks.ankiCards.errors.waitNotFound' };
  }
  return { status: 'timeout', error: null };
}

/** 块最近活动时间：started_at / first_chunk_at / progress.lastUpdatedAt 的最大值。 */
export function ankiBlockLastActivityMs(
  startedAtMs: number | null | undefined,
  firstChunkAtMs: number | null | undefined,
  toolOutputJson: string | null | undefined,
): number {
  let progressUpdatedAt: number | null = null;
  if (toolOutputJson != null) {
    try {
      const output: unknown = JSON.parse(toolOutputJson);
      if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
        const progress = (output as Record<string, unknown>).progress;
        if (progress !== null && typeof progress === 'object' && !Array.isArray(progress)) {
          const lastUpdatedAt = (progress as Record<string, unknown>).lastUpdatedAt;
          if (typeof lastUpdatedAt === 'string') {
            progressUpdatedAt = parseRfc3339(lastUpdatedAt)?.millis ?? null;
          }
        }
      }
    } catch {
      progressUpdatedAt = null;
    }
  }
  const candidates = [startedAtMs, firstChunkAtMs, progressUpdatedAt]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return candidates.length === 0 ? 0 : Math.max(...candidates);
}

export function isStaleRunningAnkiBlock(
  nowMs: number, lastActivityMs: number, pipelineActive: boolean,
): boolean {
  if (pipelineActive) return false;
  return nowMs - lastActivityMs > STALE_RUNNING_ANKI_BLOCK_AFTER_MS;
}
