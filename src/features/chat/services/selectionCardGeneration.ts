/**
 * 聊天划词制卡 — 将选中文本送入 CardForge 生成 Anki 卡片。
 *
 * Phase A MVP：最短链路 SelectionToolbar → ChatV2AnkiAdapter.generateCards。
 */

import type { TFunction } from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { ChatV2AnkiAdapter, cardAgent } from '@/components/anki/cardforge';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { APP_EVENTS, dispatchAppEvent } from '@/events';
import { getErrorMessage } from '@/utils/errorUtils';

/** 划词制卡最小选中长度（字符） */
export const MIN_SELECTION_LENGTH_FOR_CARDS = 10;

/** 短文本默认卡片配额 */
export const DEFAULT_SELECTION_MAX_CARDS = 10;

export type SelectionValidationResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'empty' | 'too_short' };

export type GenerateCardsFromSelectionResult =
  | { ok: true; documentId?: string }
  | { ok: false; reason: 'empty' | 'too_short' | 'generate_failed'; error?: string };

export interface GenerateCardsFromSelectionInput {
  selectedText: string;
  sessionId?: string | null;
  contextBefore?: string;
  contextAfter?: string;
  maxCards?: number;
  t: TFunction;
}

export function validateSelectionForCards(selectedText: string): SelectionValidationResult {
  const text = selectedText.trim();
  if (!text) return { ok: false, reason: 'empty' };
  if (text.length < MIN_SELECTION_LENGTH_FOR_CARDS) return { ok: false, reason: 'too_short' };
  return { ok: true, text };
}

/**
 * 组装送入制卡引擎的内容；可选附带前后上下文帮助消歧。
 */
export function buildSelectionCardContent(
  selectedText: string,
  options?: { contextBefore?: string; contextAfter?: string }
): string {
  const before = options?.contextBefore?.trim();
  const after = options?.contextAfter?.trim();
  if (!before && !after) return selectedText;

  const parts: string[] = [];
  if (before) {
    parts.push(`【前文上下文】\n${before}`);
  }
  parts.push(`【选中内容】\n${selectedText}`);
  if (after) {
    parts.push(`【后文上下文】\n${after}`);
  }
  return parts.join('\n\n');
}

function navigateToTaskDashboard(): void {
  dispatchAppEvent(APP_EVENTS.MOBILE_APP_NAVIGATE, { view: 'task-dashboard' });
}

async function linkDocumentToSession(documentId: string, sessionId: string): Promise<void> {
  try {
    await invoke('set_document_session_source', {
      documentId,
      sessionId,
    });
  } catch (error) {
    // 非阻断：任务仍可在任务台查看，只是无法一键跳回聊天
    console.warn('[selectionCardGeneration] set_document_session_source failed:', error);
  }
}

/**
 * 从聊天划词选中内容启动制卡任务。
 * 每次调用由后端分配新 documentId，支持并发多次划词。
 */
export async function generateCardsFromSelection(
  input: GenerateCardsFromSelectionInput
): Promise<GenerateCardsFromSelectionResult> {
  const { t } = input;
  const validated = validateSelectionForCards(input.selectedText);

  if (validated.ok === false) {
    const message =
      validated.reason === 'empty'
        ? t('selectionToolbar.makeCardsEmpty')
        : t(
            'selectionToolbar.makeCardsTooShort',
            '选中文本太短，请至少选择 {{count}} 个字符',
            { count: MIN_SELECTION_LENGTH_FOR_CARDS }
          );
    showGlobalNotification('warning', message);
    return { ok: false, reason: validated.reason };
  }

  const content = buildSelectionCardContent(validated.text, {
    contextBefore: input.contextBefore,
    contextAfter: input.contextAfter,
  });
  const maxCards = input.maxCards ?? DEFAULT_SELECTION_MAX_CARDS;

  try {
    await cardAgent.waitForReady();

    const result = await ChatV2AnkiAdapter.generateCards(content, {
      maxCards,
      deckName: t('selectionToolbar.makeCardsDeckName'),
      customRequirements: t(
        'selectionToolbar.makeCardsRequirements',
        '根据用户划选的片段生成高质量记忆卡片，优先覆盖选中内容中的关键概念与事实。'
      ),
    });

    if (!result.ok) {
      const error = result.error || t('selectionToolbar.makeCardsFailed');
      showGlobalNotification('error', error);
      return { ok: false, reason: 'generate_failed', error };
    }

    if (result.documentId && input.sessionId) {
      await linkDocumentToSession(result.documentId, input.sessionId);
    }

    showGlobalNotification(
      'success',
      t('selectionToolbar.makeCardsStarted'),
      undefined,
      {
        action: {
          label: t('selectionToolbar.openTaskDashboard'),
          onClick: navigateToTaskDashboard,
        },
        borderTone: 'neutral',
      }
    );

    return { ok: true, documentId: result.documentId };
  } catch (error: unknown) {
    const message = getErrorMessage(error) || t('selectionToolbar.makeCardsFailed');
    showGlobalNotification('error', message);
    return { ok: false, reason: 'generate_failed', error: message };
  }
}
