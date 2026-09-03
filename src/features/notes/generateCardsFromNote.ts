/**
 * 笔记正文 → 制卡任务的接线层。
 *
 * 只负责「取正文 / 取牌组名 / 取文案」，制卡链路本身复用
 * src/features/anki/generateCardsFromText.ts（与错题本、作文批改同一条 CardForge 通道），
 * 桌面工具栏与移动端底栏共用这里，避免两端各写一遍。
 */

import i18next from 'i18next';

import type { CrepeEditorApi } from '@/components/crepe/types';
import {
  generateCardsFromText,
  type GenerateCardsFromTextResult,
} from '@/features/anki/generateCardsFromText';

/** 与 NotesEditorToolbar 的 tr 同形：key + 兜底文案 */
export type NoteCardsTranslate = (key: string, defaultValue: string) => string;

export interface GenerateCardsFromNoteInput {
  editor?: CrepeEditorApi | null;
  /** 当前笔记标题；用作牌组名，缺省时回退到通用牌组 */
  noteTitle?: string | null;
  translate?: NoteCardsTranslate;
}

/** 未初始化的 i18next 会返回 undefined，这里统一回退到调用方兜底文案 */
function defaultTranslate(key: string, defaultValue: string): string {
  try {
    const value = i18next.t(key, { defaultValue });
    return typeof value === 'string' && value.length > 0 ? value : defaultValue;
  } catch {
    return defaultValue;
  }
}

/** 窗口化加载的长笔记里 getMarkdown() 只是可见前缀，制卡要拿全文 */
export function readNoteMarkdown(editor?: CrepeEditorApi | null): string {
  if (!editor) return '';
  try {
    return editor.getFullMarkdown?.() ?? editor.getMarkdown() ?? '';
  } catch {
    return '';
  }
}

export async function generateCardsFromNote(
  input: GenerateCardsFromNoteInput,
): Promise<GenerateCardsFromTextResult> {
  const tr = input.translate ?? defaultTranslate;
  const title = input.noteTitle?.trim();

  return generateCardsFromText({
    content: readNoteMarkdown(input.editor),
    deckName: title && title.length > 0 ? title : tr('notes:generateCards.deckName', '笔记制卡'),
    requirements: tr(
      'notes:generateCards.requirements',
      '基于这篇笔记的要点出卡，保留原文的术语与表述，跳过纯格式化内容。',
    ),
    messages: {
      tooShort: tr('notes:generateCards.tooShort', '笔记内容太短，先写点内容再生成卡片'),
      started: tr('notes:generateCards.started', '已开始根据笔记生成卡片'),
      failed: tr('notes:generateCards.failed', '生成卡片失败'),
      openTaskDashboard: tr('notes:generateCards.openTaskDashboard', '查看任务'),
    },
  });
}
