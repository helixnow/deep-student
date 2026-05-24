import type { AttachmentMeta } from './common';
import type { ContextRef } from '../../context/types';

export type QueuedMessageStatus = 'pending' | 'failed';

export interface QueuedMessage {
  id: string;
  content: string;
  attachments: AttachmentMeta[];
  contextRefs: ContextRef[];
  createdAt: number;
  status: QueuedMessageStatus;
  /** Human-readable error surfaced via tooltip on the failed bubble. */
  error?: string;
  /**
   * 该项是通过「引导」操作进入发送的（用户硬打断当前回复并优先此条）。
   * 出队成功后会传播到 user message 的 `_meta.steered`，用于聊天页徽章。
   */
  steered?: boolean;
}

export const QUEUE_HARD_CAP = 5;
export const QUEUE_DEQUEUE_BREATHER_MS = 300;

/**
 * Tolerantly read the "blocking interaction" sentinel from a store snapshot.
 *
 * Two field names exist in the codebase:
 * - `pendingApprovalRequest` (HEAD, original tool-approval-only shape)
 * - `pendingBlockingInteraction` (in-progress refactor, discriminated union for
 *   tool_approval / ask_user / tool_limit)
 *
 * Whichever is non-null at runtime indicates the input bar is blocked and the
 * queue must NOT auto-dequeue. We read both so this code compiles and behaves
 * correctly regardless of which migration step is active.
 */
export function readBlockingInteraction(state: unknown): unknown {
  const s = state as {
    pendingBlockingInteraction?: unknown;
    pendingApprovalRequest?: unknown;
  };
  return s.pendingBlockingInteraction ?? s.pendingApprovalRequest ?? null;
}
