/**
 * Generative UI ↔ Chat blockRegistry 桥接
 *
 * 允许 Chat 流中通过 generative_ui 块渲染结构化 UI 意图。
 */

import type { GenerativeUIIntent } from '../types';
import { tryParsePartialIntent } from '../parser';
import { generativeUIIntentSchema, parseGenerativeUIIntent } from '../schema';
import {
  appendGenerativeUIStreamContent,
  finalizeGenerativeUIStream,
  resetGenerativeUIStream,
} from './generativeUIStreamRegistry';
import { extractIntentFromToolArgs } from './extractIntentFromToolArgs';
import type {
  GenerativeUIInteraction,
  GenerativeUIPersistedAnswer,
} from '../interaction/types';

export const GENERATIVE_UI_BLOCK_TYPE = 'generative_ui';

const EMPTY_STREAMING_INTENT: GenerativeUIIntent = { version: '1', blocks: [] };

export interface GenerativeUIBlockOutput {
  intent?: string | GenerativeUIIntent;
  isStreaming?: boolean;
  /**
   * 交互作答（awaitAnswer）：live start 写 { awaitAnswer, interaction: pending }，
   * end / DB 回放写 { interaction, answer? }。这些输出可能不带 intent——
   * 此时 intent 回退到流式 content（live 完整 intent chunk）或 toolInput.intent（回放）。
   */
  awaitAnswer?: boolean;
  interaction?: GenerativeUIInteraction;
  answer?: GenerativeUIPersistedAnswer;
}

/**
 * tool_call_preparing 阶段（block.isPreparing，content 是原始工具参数而非 intent）：
 * 从参数里截取 intent 源文本喂给流式解析器，只渲染已闭合 block；
 * 还没流到 intent 时返回空意图（流式骨架）。
 */
export function extractPreparingGenerativeUIIntent(
  blockId: string,
  toolArgs: string | null | undefined,
): { intent: GenerativeUIIntent; isStreaming: true } {
  const source = extractIntentFromToolArgs(toolArgs) ?? '';
  const snapshot = appendGenerativeUIStreamContent(blockId, source);
  return { intent: snapshot.intent ?? EMPTY_STREAMING_INTENT, isStreaming: true };
}

function validateIntentObject(value: unknown): GenerativeUIIntent | null {
  const result = generativeUIIntentSchema.safeParse(value);
  return result.success ? (result.data as GenerativeUIIntent) : null;
}

/** 终态 intent 规范化：对象过 zod；字符串走严格解析 */
export function normalizeGenerativeUIEndIntent(intent: unknown): GenerativeUIIntent | string | null {
  if (intent === undefined || intent === null) return null;
  if (typeof intent === 'string') {
    const parsed = parseGenerativeUIIntent(intent);
    return parsed.ok ? parsed.intent : intent;
  }
  return validateIntentObject(intent);
}

/** 从 chat block toolOutput / 流式 content / toolInput 提取可渲染意图 */
export function extractGenerativeUIIntent(
  toolOutput: unknown,
  content?: string | null,
  toolInput?: unknown,
  blockId?: string,
): { intent: GenerativeUIIntent | string; isStreaming: boolean } | null {
  if (toolOutput && typeof toolOutput === 'object') {
    const data = toolOutput as GenerativeUIBlockOutput;
    if (data.intent !== undefined) {
      if (typeof data.intent === 'string') {
        const parsed = parseGenerativeUIIntent(data.intent);
        if (parsed.ok) {
          if (blockId) resetGenerativeUIStream(blockId);
          return { intent: parsed.intent, isStreaming: !!data.isStreaming };
        }
        if (data.isStreaming) {
          const partial = blockId
            ? appendGenerativeUIStreamContent(blockId, data.intent).intent
            : tryParsePartialIntent(data.intent);
          return { intent: partial ?? EMPTY_STREAMING_INTENT, isStreaming: true };
        }
        return { intent: data.intent, isStreaming: false };
      }
      const validated = validateIntentObject(data.intent);
      if (validated) {
        if (blockId && !data.isStreaming) resetGenerativeUIStream(blockId);
        return { intent: validated, isStreaming: !!data.isStreaming };
      }
      return null;
    }
  }

  const trimmed = content?.trim();
  if (trimmed) {
    const parsed = parseGenerativeUIIntent(trimmed);
    if (parsed.ok) {
      if (blockId) resetGenerativeUIStream(blockId);
      return { intent: parsed.intent, isStreaming: false };
    }
    const partial = blockId
      ? appendGenerativeUIStreamContent(blockId, trimmed).intent
      : tryParsePartialIntent(trimmed);
    return { intent: partial ?? EMPTY_STREAMING_INTENT, isStreaming: true };
  }

  if (toolInput && typeof toolInput === 'object' && 'intent' in toolInput) {
    const raw = (toolInput as { intent?: unknown }).intent;
    const normalized = normalizeGenerativeUIEndIntent(raw);
    if (normalized !== null) {
      if (blockId) resetGenerativeUIStream(blockId);
      return { intent: normalized, isStreaming: false };
    }
  }

  return null;
}
