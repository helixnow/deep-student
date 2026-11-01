/**
 * Generative UI 交互作答 — Tauri 命令封装（方案 2.3）
 *
 * - chat_v2_genui_submit_answer → 'accepted' | 'expired'；
 *   答案校验失败时后端 reject 纯字符串 "GENUI_ANSWER_INVALID: …"，映射为 { invalid }。
 * - chat_v2_genui_dismiss_answer(reason: 'user_message' | 'skipped') → 'accepted' | 'expired'。
 * - chat_v2_genui_list_pending_answers → 仍在等待的 toolCallId 列表。
 * 其它错误（参数不合法 ChatV2Error JSON、IPC 失败）原样抛出。
 */

import { invoke } from '@tauri-apps/api/core';
import type { GenerativeUIAnswerPayload, GenerativeUISubmitOutcome } from '../interaction/types';

export const GENUI_ANSWER_INVALID_PREFIX = 'GENUI_ANSWER_INVALID:';

export type GenuiDismissReason = 'user_message' | 'skipped';
export type GenuiAckStatus = 'accepted' | 'expired';

interface GenuiAck {
  status?: unknown;
}

function readAckStatus(ack: unknown): GenuiAckStatus {
  const status = ack && typeof ack === 'object' ? (ack as GenuiAck).status : undefined;
  return status === 'accepted' ? 'accepted' : 'expired';
}

function errorText(error: unknown): string | null {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  return null;
}

/** "GENUI_ANSWER_INVALID: xxx" → "xxx"；不是该错误返回 null */
export function parseGenuiAnswerInvalidError(error: unknown): string | null {
  const text = errorText(error);
  if (text === null) return null;
  const trimmed = text.trim();
  if (!trimmed.startsWith(GENUI_ANSWER_INVALID_PREFIX)) return null;
  return trimmed.slice(GENUI_ANSWER_INVALID_PREFIX.length).trim() || trimmed;
}

export async function submitGenuiAnswer(
  sessionId: string,
  toolCallId: string,
  payload: GenerativeUIAnswerPayload,
): Promise<GenerativeUISubmitOutcome> {
  try {
    const ack = await invoke<unknown>('chat_v2_genui_submit_answer', {
      sessionId,
      toolCallId,
      summary: payload.summary,
      data: payload.data,
    });
    return readAckStatus(ack);
  } catch (error: unknown) {
    const invalid = parseGenuiAnswerInvalidError(error);
    if (invalid !== null) return { invalid };
    throw error;
  }
}

export async function dismissGenuiAnswer(
  sessionId: string,
  toolCallId: string,
  reason: GenuiDismissReason,
): Promise<GenuiAckStatus> {
  const ack = await invoke<unknown>('chat_v2_genui_dismiss_answer', {
    sessionId,
    toolCallId,
    reason,
  });
  return readAckStatus(ack);
}

export async function listPendingGenuiAnswers(sessionId: string): Promise<string[]> {
  const result = await invoke<unknown>('chat_v2_genui_list_pending_answers', { sessionId });
  return Array.isArray(result) ? result.filter((id): id is string => typeof id === 'string') : [];
}
