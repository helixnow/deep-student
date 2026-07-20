/**
 * Chat V2 - 上下文压缩/截断的用户反馈辅助（纯函数）
 *
 * 契约（与后端 chat_v2 对齐）：
 * - 手动压缩命令 `chat_v2_compact_session` 返回
 *   `{ status: 'compacted' | 'notNeeded' | 'skipped' | 'failed', reason?: string }`；
 *   联调期间可能仍返回旧的 boolean，需降级兼容。
 * - 会话事件 `compaction_failed` payload：`{ reason: string }`
 * - 会话事件 `context_trimmed` payload：
 *   `{ droppedMessages: number, estimatedDroppedTokens?: number }`
 */

// ============================================================================
// 手动压缩结果归一化
// ============================================================================

export type CompactSessionStatus = 'compacted' | 'notNeeded' | 'skipped' | 'failed';

export interface CompactSessionResponse {
  status: CompactSessionStatus;
  reason?: string;
}

const COMPACT_STATUSES: readonly CompactSessionStatus[] = [
  'compacted',
  'notNeeded',
  'skipped',
  'failed',
];

/**
 * 归一化后端返回：
 * - 新契约对象 → 原样返回（校验 status 合法性）
 * - 旧 boolean（联调兼容）→ true=compacted / false=notNeeded
 * - 其他未知形状 → failed（携带 reason='invalidResponse'）
 */
export function normalizeCompactSessionResponse(raw: unknown): CompactSessionResponse {
  if (typeof raw === 'boolean') {
    return { status: raw ? 'compacted' : 'notNeeded' };
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    const status = record.status;
    if (typeof status === 'string' && (COMPACT_STATUSES as readonly string[]).includes(status)) {
      const reason = typeof record.reason === 'string' && record.reason ? record.reason : undefined;
      return reason
        ? { status: status as CompactSessionStatus, reason }
        : { status: status as CompactSessionStatus };
    }
  }
  return { status: 'failed', reason: 'invalidResponse' };
}

// ============================================================================
// reason 码 → i18n key（chatV2:compaction.reason.*）
// ============================================================================

const KNOWN_COMPACTION_REASONS = new Set([
  'sessionTooShort',
  'usableTooSmall',
  'lockBusy',
  'streaming',
  'summaryFailed',
  'cancelled',
  'staleLineage',
  'invalidResponse',
]);

/**
 * 返回 reason 码对应的 i18n key（chatV2 命名空间内）。
 * 未知 reason 统一落到 `compaction.reason.unknown`。
 */
export function compactionReasonI18nKey(reason: string | undefined): string {
  if (reason && KNOWN_COMPACTION_REASONS.has(reason)) {
    return `compaction.reason.${reason}`;
  }
  return 'compaction.reason.unknown';
}

// ============================================================================
// context_trimmed 事件的合并/节流
// ============================================================================

export const CONTEXT_TRIM_NOTIFY_WINDOW_MS = 30_000;

export interface ContextTrimmedPayload {
  droppedMessages: number;
  estimatedDroppedTokens?: number;
}

/** 从事件 payload（camelCase 序列化）解析出截断信息；非法 payload 返回 null */
export function parseContextTrimmedPayload(payload: unknown): ContextTrimmedPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  const dropped = record.droppedMessages;
  if (typeof dropped !== 'number' || !Number.isFinite(dropped) || dropped <= 0) return null;
  const tokens = record.estimatedDroppedTokens;
  const estimatedDroppedTokens =
    typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
      ? Math.floor(tokens)
      : undefined;
  return {
    droppedMessages: Math.floor(dropped),
    ...(estimatedDroppedTokens !== undefined ? { estimatedDroppedTokens } : {}),
  };
}

/** 从 compaction_failed 事件 payload 解析 reason；缺失时返回 undefined */
export function parseCompactionFailedReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason ? reason : undefined;
}

interface TrimThrottleEntry {
  lastNotifiedAt: number;
  pendingDroppedMessages: number;
  pendingDroppedTokens: number;
}

export interface TrimThrottleDecision {
  /** 本次是否应该向用户提示 */
  notify: boolean;
  /** 提示时应展示的累计丢弃消息数（含节流窗口内被合并的事件） */
  droppedMessages: number;
  /** 提示时应展示的累计估算 token 数（无数据时为 undefined） */
  estimatedDroppedTokens?: number;
}

/**
 * context_trimmed 提示节流器（按会话隔离）。
 *
 * 规则：同一会话 30s 窗口内只提示一次；窗口内到达的事件被静默合并
 * （累计 droppedMessages / estimatedDroppedTokens），窗口过后
 * 下一个事件触发提示时一并计入。
 */
export function createContextTrimThrottle(windowMs: number = CONTEXT_TRIM_NOTIFY_WINDOW_MS) {
  const entries = new Map<string, TrimThrottleEntry>();

  return {
    record(
      sessionId: string,
      payload: ContextTrimmedPayload,
      now: number = Date.now(),
    ): TrimThrottleDecision {
      const entry = entries.get(sessionId);
      if (entry && now - entry.lastNotifiedAt < windowMs) {
        entry.pendingDroppedMessages += payload.droppedMessages;
        entry.pendingDroppedTokens += payload.estimatedDroppedTokens ?? 0;
        return { notify: false, droppedMessages: 0 };
      }

      const droppedMessages = (entry?.pendingDroppedMessages ?? 0) + payload.droppedMessages;
      const droppedTokens = (entry?.pendingDroppedTokens ?? 0) + (payload.estimatedDroppedTokens ?? 0);
      entries.set(sessionId, {
        lastNotifiedAt: now,
        pendingDroppedMessages: 0,
        pendingDroppedTokens: 0,
      });
      return {
        notify: true,
        droppedMessages,
        ...(droppedTokens > 0 ? { estimatedDroppedTokens: droppedTokens } : {}),
      };
    },
    /** 会话销毁/切换时清理，防止 Map 无界增长 */
    clear(sessionId: string): void {
      entries.delete(sessionId);
    },
    reset(): void {
      entries.clear();
    },
  };
}

export type ContextTrimThrottle = ReturnType<typeof createContextTrimThrottle>;
