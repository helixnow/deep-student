/**
 * Generative UI 交互作答 — 从 chat 块读取交互状态（方案 2.6）
 *
 * 数据来源（按优先级）：
 * - block.toolOutput.interaction / toolOutput.answer：end 事件或 DB 回放（含预存 pending 快照）；
 * - block.toolOutput.awaitAnswer === true 或 block.toolInput.awaitAnswer === true：
 *   live 路径 start 后、end 前（WP-F 可用 buildPendingGenerativeUIInteraction 写入 toolOutput）。
 *
 * 规则：
 * - answered / dismissed / cancelled / interrupted：原样只读回显，canSubmit=false。
 * - pending 且 block.status==='error' 且无 answer → cancelled（stopped）。
 * - pending 且 block.status==='running' 且会话流式中（sending/streaming）→ 可作答，不发 IPC。
 * - 其他 pending：livePending===true → 可作答；false → interrupted；未知(null/undefined) →
 *   pending + needsPendingCheck=true（调用方调一次 chat_v2_genui_list_pending_answers）。
 */

import type {
  GenerativeUIAnswerData,
  GenerativeUIInteraction,
  GenerativeUIInteractionReason,
  GenerativeUIInteractionState,
  GenerativeUIPersistedAnswer,
} from './types';

/** 与 chat Block 结构兼容的最小形状（避免依赖 chat store 类型） */
export interface GenerativeUIInteractionBlockLike {
  status?: 'pending' | 'running' | 'success' | 'error' | string;
  toolCallId?: string;
  toolInput?: Record<string, unknown>;
  toolOutput?: unknown;
}

export interface ReadGenerativeUIInteractionContext {
  /** ChatStore.sessionStatus：'idle' | 'sending' | 'streaming' | 'aborting' */
  sessionStatus: string;
  /** list_pending 结果：true=后端仍在等待该 toolCallId；false=不在；null/undefined=未查 */
  livePending?: boolean | null;
}

export interface GenerativeUIInteractionReadResult {
  state: GenerativeUIInteractionState;
  reason?: GenerativeUIInteractionReason;
  toolCallId?: string;
  canSubmit: boolean;
  /** pending 且无法从流状态判定：需要查 list_pending */
  needsPendingCheck: boolean;
  answered?: { summary: string; data: GenerativeUIAnswerData };
}

const INTERACTION_STATES: readonly GenerativeUIInteractionState[] = [
  'pending',
  'answered',
  'dismissed',
  'cancelled',
  'interrupted',
];
const INTERACTION_REASONS: readonly GenerativeUIInteractionReason[] = [
  'user_message',
  'skipped',
  'stopped',
  'interrupted',
];
const STREAMING_SESSION_STATUSES = new Set(['sending', 'streaming']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 宽松解析 toolOutput.interaction；非法返回 null */
export function parseGenerativeUIInteraction(value: unknown): GenerativeUIInteraction | null {
  if (!isRecord(value)) return null;
  const state = value.state;
  if (typeof state !== 'string' || !(INTERACTION_STATES as readonly string[]).includes(state)) return null;
  const reason =
    typeof value.reason === 'string' && (INTERACTION_REASONS as readonly string[]).includes(value.reason)
      ? (value.reason as GenerativeUIInteractionReason)
      : undefined;
  return {
    mode: 'await',
    toolCallId: typeof value.toolCallId === 'string' ? value.toolCallId : '',
    state: state as GenerativeUIInteractionState,
    ...(reason ? { reason } : {}),
    ...(typeof value.answeredAt === 'number' ? { answeredAt: value.answeredAt } : {}),
  };
}

/** 宽松解析 toolOutput.answer；summary 非空且 data 为对象才算有效 */
export function parseGenerativeUIPersistedAnswer(value: unknown): GenerativeUIPersistedAnswer | null {
  if (!isRecord(value)) return null;
  if (typeof value.summary !== 'string' || !value.summary.trim()) return null;
  if (!isRecord(value.data)) return null;
  return {
    summary: value.summary,
    data: value.data as GenerativeUIAnswerData,
    ...(Array.isArray(value.resolved)
      ? { resolved: value.resolved as GenerativeUIPersistedAnswer['resolved'] }
      : {}),
    ...(value.trust === 'untrusted_user_input' ? { trust: 'untrusted_user_input' as const } : {}),
  };
}

/** live start（awaitAnswer:true）时写入 toolOutput 的 pending 交互 */
export function buildPendingGenerativeUIInteraction(toolCallId: string): GenerativeUIInteraction {
  return { mode: 'await', toolCallId, state: 'pending' };
}

export function readGenerativeUIInteraction(
  block: GenerativeUIInteractionBlockLike,
  ctx: ReadGenerativeUIInteractionContext,
): GenerativeUIInteractionReadResult | null {
  const output = isRecord(block.toolOutput) ? block.toolOutput : undefined;
  const interaction = parseGenerativeUIInteraction(output?.interaction);
  const awaitRequested =
    output?.awaitAnswer === true || block.toolInput?.awaitAnswer === true;
  if (!interaction && !awaitRequested) return null;

  const toolCallId = interaction?.toolCallId || block.toolCallId || undefined;
  const answer = parseGenerativeUIPersistedAnswer(output?.answer);
  const base = { ...(toolCallId ? { toolCallId } : {}) };

  if (answer && (!interaction || interaction.state === 'answered' || interaction.state === 'pending')) {
    return {
      ...base,
      state: 'answered',
      canSubmit: false,
      needsPendingCheck: false,
      answered: { summary: answer.summary, data: answer.data },
    };
  }

  const state = interaction?.state ?? 'pending';
  if (state !== 'pending') {
    // answered 但 answer 缺失：仍显示已回答，无回显数据
    return {
      ...base,
      state,
      ...(interaction?.reason ? { reason: interaction.reason } : {}),
      canSubmit: false,
      needsPendingCheck: false,
    };
  }

  if (block.status === 'error') {
    return { ...base, state: 'cancelled', reason: 'stopped', canSubmit: false, needsPendingCheck: false };
  }

  if (block.status === 'running' && STREAMING_SESSION_STATUSES.has(ctx.sessionStatus)) {
    return { ...base, state: 'pending', canSubmit: Boolean(toolCallId), needsPendingCheck: false };
  }

  if (ctx.livePending === true) {
    return { ...base, state: 'pending', canSubmit: Boolean(toolCallId), needsPendingCheck: false };
  }
  if (ctx.livePending === false) {
    return { ...base, state: 'interrupted', reason: 'interrupted', canSubmit: false, needsPendingCheck: false };
  }
  return { ...base, state: 'pending', canSubmit: false, needsPendingCheck: Boolean(toolCallId) };
}
