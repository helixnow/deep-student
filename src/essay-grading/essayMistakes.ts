/**
 * 作文批改 → 错题本：把批改标记里的「改写 / 错误」整理成改错题写入「作文错题」题目集。
 * 错误点从此可以练习、进复习计划、按错误类型计入掌握度（标签 = 错误类型），
 * 而不是只停留在一次性的批改文本里。
 */
import i18next from 'i18next';
import { invoke } from '@tauri-apps/api/core';
import { parseStreamingContent } from './streamingMarkerParser';
import { ensureNamedExam } from '@/utils/ensureNamedExam';

export interface EssayMistakeDraft {
  content: string;
  answer?: string;
  explanation?: string;
  tags: string[];
}

const oneLine = (s?: string) => (s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const MAX_ITEMS = 30;

export function buildEssayMistakeDrafts(rawGrading: string): EssayMistakeDraft[] {
  const t = (key: string, options?: Record<string, unknown>) => i18next.t(`essay_grading:mistakes.${key}`, options ?? {}) as string;
  const subject = t('tag', { defaultValue: '作文' });
  const seen = new Set<string>();
  const drafts: EssayMistakeDraft[] = [];
  for (const marker of parseStreamingContent(rawGrading, true).markers) {
    let draft: EssayMistakeDraft | null = null;
    if (marker.type === 'replace' && oneLine(marker.oldText)) {
      draft = {
        content: t('replace_prompt', { defaultValue: '改正下列句子中的问题：\n{{text}}', text: oneLine(marker.oldText) }),
        answer: oneLine(marker.newText) || undefined,
        explanation: oneLine(marker.reason) || undefined,
        tags: [subject, t('replace_tag', { defaultValue: '改写' })],
      };
    } else if (marker.type === 'err' && oneLine(marker.content)) {
      const typeLabel = marker.errorType
        ? (i18next.t(`essay_grading:markers.error.${marker.errorType}`, { defaultValue: marker.errorType }) as string)
        : t('error_tag', { defaultValue: '错误' });
      draft = {
        content: t('error_prompt', { defaultValue: '指出并改正下列内容中的错误：\n{{text}}', text: oneLine(marker.content) }),
        explanation: oneLine(marker.explanation) || undefined,
        // 错误类型放首位：掌握度按首个标签归类知识点
        tags: [typeLabel, subject],
      };
    }
    if (draft && !seen.has(draft.content)) {
      seen.add(draft.content);
      drafts.push(draft);
    }
    if (drafts.length >= MAX_ITEMS) break;
  }
  return drafts;
}

/** 写入「作文错题」题目集；返回写入题数与题目集 id */
export async function saveEssayMistakes(rawGrading: string): Promise<{ count: number; examId: string | null }> {
  const drafts = buildEssayMistakeDrafts(rawGrading);
  if (drafts.length === 0) return { count: 0, examId: null };
  const examId = await ensureNamedExam(
    i18next.t('essay_grading:mistakes.set_name', { defaultValue: '作文错题' }) as string,
    'essayGrading.mistakeExamId',
  );
  await invoke('qbank_batch_create_questions', {
    paramsList: drafts.map((draft) => ({
      exam_id: examId,
      content: draft.content,
      answer: draft.answer ?? null,
      explanation: draft.explanation ?? null,
      tags: draft.tags,
      source_type: 'manual',
    })),
  });
  return { count: drafts.length, examId };
}
