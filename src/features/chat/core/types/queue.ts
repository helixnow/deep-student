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
 * 🔧 P0-3 读路径收敛：本函数是逻辑层读取阻塞交互的唯一入口（SSOT read path）。
 *
 * Two field names exist in the codebase:
 * - `pendingBlockingInteraction`：唯一事实源（discriminated union for
 *   tool_approval / ask_user / tool_limit / plan_gate）
 * - `pendingApprovalRequest`：兼容旧字段，由 sessionActions 的
 *   blockingInteractionPatch 保持为新字段的严格派生镜像（仅 tool_approval）
 *
 * Whichever is non-null at runtime indicates the input bar is blocked and the
 * queue must NOT auto-dequeue.
 *
 * 约束：
 * - 逻辑层（store/guards/sessionManager/AdapterManager/hooks）判断"是否被阻塞"
 *   必须使用本函数，禁止直接读单个字段；
 * - UI 组件在并行改造，暂可继续读旧字段渲染，但新代码同样应经此入口。
 */
export function readBlockingInteraction(state: unknown): unknown {
  const s = state as {
    pendingBlockingInteraction?: unknown;
    pendingApprovalRequest?: unknown;
  };
  return s.pendingBlockingInteraction ?? s.pendingApprovalRequest ?? null;
}
