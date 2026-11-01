/**
 * Generative UI 交互作答 — 会话级等待运行时（方案 2.5）
 *
 * 用户在输入框发消息（流式中入队）或点击 followup 时，中止当前会话里仍在等待作答的
 * generative_ui 块：对每个 live pending 块调 chat_v2_genui_dismiss_answer。
 * 后端以 yieldTurn 结束本轮，流结束空闲后队列自动发出用户消息。
 */

import { readGenerativeUIInteraction } from '../interaction/readInteraction';
import { dismissGenuiAnswer, type GenuiDismissReason } from './genuiInteractionApi';
import { GENERATIVE_UI_BLOCK_TYPE } from './chatBlockBridge';

interface GenuiAwaitBlockLike {
  type?: string;
  status?: string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
}

/** ChatStore 状态的最小形状（避免依赖 chat store 类型） */
export interface GenuiAwaitStoreState {
  sessionId: string;
  sessionStatus: string;
  blocks: Map<string, GenuiAwaitBlockLike>;
}

export type GenuiAwaitStoreInput =
  | GenuiAwaitStoreState
  | { getState(): GenuiAwaitStoreState };

function resolveState(store: GenuiAwaitStoreInput): GenuiAwaitStoreState {
  const maybeApi = store as { getState?: unknown };
  return typeof maybeApi.getState === 'function'
    ? (store as { getState(): GenuiAwaitStoreState }).getState()
    : (store as GenuiAwaitStoreState);
}

/**
 * 当前会话中 live 等待作答的 toolCallId（state==='pending' 且可由流状态直接判定为可作答）。
 * DB 恢复、需要 list_pending 才能判定的块不计入——那时没有活跃流，也就没有可中止的等待。
 */
export function collectLivePendingGenerativeUiAwaits(store: GenuiAwaitStoreInput): string[] {
  const state = resolveState(store);
  const ids: string[] = [];
  const blocks = state.blocks;
  if (!blocks || typeof blocks.values !== 'function') return ids;
  for (const block of blocks.values()) {
    if (!block || block.type !== GENERATIVE_UI_BLOCK_TYPE) continue;
    const read = readGenerativeUIInteraction(block, { sessionStatus: state.sessionStatus });
    if (!read || read.state !== 'pending' || !read.canSubmit || !read.toolCallId) continue;
    if (!ids.includes(read.toolCallId)) ids.push(read.toolCallId);
  }
  return ids;
}

/**
 * 中止当前会话所有 live 等待；返回已发起 dismiss 的 toolCallId。
 * 单个失败只告警（expired / IPC 错误都不影响用户消息入队）。
 */
export async function dismissPendingGenerativeUiAwait(
  store: GenuiAwaitStoreInput,
  reason: GenuiDismissReason,
): Promise<string[]> {
  const state = resolveState(store);
  const ids = collectLivePendingGenerativeUiAwaits(state);
  if (ids.length === 0 || !state.sessionId) return [];
  await Promise.all(
    ids.map((toolCallId) =>
      dismissGenuiAnswer(state.sessionId, toolCallId, reason).catch((error: unknown) => {
        console.warn('[GenerativeUI] dismiss await failed:', toolCallId, error);
        return 'expired' as const;
      }),
    ),
  );
  return ids;
}
