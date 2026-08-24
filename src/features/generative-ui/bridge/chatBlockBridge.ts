/**
 * Generative UI ↔ Chat blockRegistry 桥接
 *
 * 允许 Chat 流中通过 generative_ui 块渲染结构化 UI 意图。
 */

import type { GenerativeUIIntent } from '../types';
import { parseGenerativeUIIntent } from '../schema';

export const GENERATIVE_UI_BLOCK_TYPE = 'generative_ui';

export interface GenerativeUIBlockOutput {
  intent?: string | GenerativeUIIntent;
  isStreaming?: boolean;
}

/** 从 chat block toolOutput 提取可渲染意图 */
export function extractGenerativeUIIntent(
  toolOutput: unknown,
): { intent: GenerativeUIIntent | string; isStreaming: boolean } | null {
  if (!toolOutput || typeof toolOutput !== 'object') return null;
  const data = toolOutput as GenerativeUIBlockOutput;
  if (!data.intent) return null;
  if (typeof data.intent === 'string') {
    const parsed = parseGenerativeUIIntent(data.intent);
    if (!parsed.ok) return { intent: data.intent, isStreaming: !!data.isStreaming };
    return { intent: parsed.intent, isStreaming: !!data.isStreaming };
  }
  return { intent: data.intent, isStreaming: !!data.isStreaming };
}
