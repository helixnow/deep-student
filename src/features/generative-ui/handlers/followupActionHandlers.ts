/**
 * send-followup — action-bar 中 id 为 followup:<slug> 且带 prompt 的按钮（方案 1.3）。
 *
 * 点击后以用户身份发送 prompt：
 * - 会话空闲：入队后立即出队发送（走 maybeDequeue，发送只带本条快照的空上下文引用，
 *   不会顺带消费用户正在输入框里组合的附件/引用）；store 无 maybeDequeue 时直接 sendMessage。
 * - 流式中：入队，并中止当前 awaitAnswer 等待（dismiss user_message → 后端 yieldTurn）。
 *
 * 风险确认沿用 ActionBar 既有机制：handler 注册为 low，有效风险 = max(模型声明, low)，
 * 模型 confirm=true 时 schema 已把 riskLevel 提升到 medium → 行内二次确认。
 * handler 的 label 沿用模型 label（ActionBar 优先显示 handler label）。
 */

import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { GenerativeActionDefinition, GenerativeUIIntent } from '../types';
import {
  GENUI_FOLLOWUP_ACTION_ID_RE,
  GENUI_FOLLOWUP_PROMPT_MAX_CHARS,
  GENUI_MAX_FOLLOWUP_ACTIONS,
  countGenuiChars,
} from '../interaction/limits';
import { dismissPendingGenerativeUiAwait, type GenuiAwaitStoreState } from '../bridge/genuiAwaitRuntime';

/** 与 chat/core/types/queue.ts QUEUE_HARD_CAP 同值（避免 generative-ui 依赖 chat 内部常量） */
const FOLLOWUP_QUEUE_HARD_CAP = 5;

/** followup 需要的 ChatStore 最小形状 */
export interface FollowupChatState extends GenuiAwaitStoreState {
  queuedMessages?: unknown[];
  enqueueMessage(content: string, attachments: never[], contextRefs: never[]): void;
  maybeDequeue?(): Promise<void>;
  sendMessage(content: string, attachments?: never[]): Promise<void>;
  canSend?(): boolean;
}

export interface FollowupChatStoreApi {
  getState(): FollowupChatState;
}

export interface FollowupActionSpec {
  id: string;
  label: string;
  prompt: string;
}

/** 从 intent 的 action-bar 中收集合法 followup（id 正则、prompt 1..500、最多 4 个） */
export function collectFollowupActions(intent: GenerativeUIIntent): FollowupActionSpec[] {
  const specs: FollowupActionSpec[] = [];
  const seen = new Set<string>();
  for (const block of intent.blocks ?? []) {
    if (block.type !== 'action-bar') continue;
    const actions = (block.props as { actions?: unknown })?.actions;
    if (!Array.isArray(actions)) continue;
    for (const raw of actions) {
      if (!raw || typeof raw !== 'object') continue;
      const action = raw as { id?: unknown; label?: unknown; prompt?: unknown };
      if (typeof action.id !== 'string' || !GENUI_FOLLOWUP_ACTION_ID_RE.test(action.id)) continue;
      if (seen.has(action.id)) continue;
      if (typeof action.prompt !== 'string') continue;
      const prompt = action.prompt.trim();
      if (!prompt || countGenuiChars(prompt) > GENUI_FOLLOWUP_PROMPT_MAX_CHARS) continue;
      seen.add(action.id);
      specs.push({
        id: action.id,
        label: typeof action.label === 'string' && action.label ? action.label : prompt,
        prompt,
      });
      if (specs.length >= GENUI_MAX_FOLLOWUP_ACTIONS) return specs;
    }
  }
  return specs;
}

/** 以用户身份发送 followup prompt；返回实际走的路径 */
export async function sendGenerativeUIFollowup(
  store: FollowupChatStoreApi,
  prompt: string,
): Promise<'sent' | 'queued' | 'rejected'> {
  const state = store.getState();
  const queueLength = state.queuedMessages?.length ?? 0;

  if (state.sessionStatus !== 'idle') {
    if (queueLength >= FOLLOWUP_QUEUE_HARD_CAP) {
      showGlobalNotification('warning', i18n.t('chatV2:queue.fullTooltip'));
      return 'rejected';
    }
    state.enqueueMessage(prompt, [], []);
    await dismissPendingGenerativeUiAwait(store, 'user_message');
    return 'queued';
  }

  if (typeof state.canSend === 'function' && !state.canSend()) {
    showGlobalNotification('warning', i18n.t('chatV2:inputBar.sendGuard.notReady'));
    return 'rejected';
  }

  // 发送不等待完成：send 链路可能远超 ActionBar 的 15s handler 超时。
  // maybeDequeue 自己把发送失败落为 failed 队列项（可重试）。
  if (typeof state.maybeDequeue === 'function' && queueLength < FOLLOWUP_QUEUE_HARD_CAP) {
    state.enqueueMessage(prompt, [], []);
    void store.getState().maybeDequeue?.();
    return 'sent';
  }

  void state.sendMessage(prompt, []).catch((error: unknown) => {
    console.error('[GenerativeUI] followup send failed:', error);
  });
  return 'sent';
}

export function createFollowupActionHandlers(
  intent: GenerativeUIIntent,
  getStore: () => FollowupChatStoreApi | null | undefined,
): Record<string, GenerativeActionDefinition> {
  const handlers: Record<string, GenerativeActionDefinition> = {};
  for (const spec of collectFollowupActions(intent)) {
    handlers[spec.id] = {
      id: spec.id,
      label: spec.label,
      riskLevel: 'low',
      handler: async () => {
        const store = getStore();
        if (!store) return;
        await sendGenerativeUIFollowup(store, spec.prompt);
      },
    };
  }
  return handlers;
}
