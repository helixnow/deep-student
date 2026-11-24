import i18next from 'i18next';
import { parseStreamingContent } from '@/essay-grading/streamingMarkerParser';

export interface EssayMistakeDraft {
  content: string;
  answer?: string;
  explanation?: string;
  tags: string[];
}

export type EssayMistakeCategory = 'error' | 'suggestion';

export interface ClassifiedEssayMistakeItem {
  draft: EssayMistakeDraft;
  category: EssayMistakeCategory;
  title: string;
}

export interface BuildEssayMistakeOptions {
  /** 是否同时收录建议类标记（replace / 用词表达修辞类 err）。默认 true 以保持调用兼容 */
  includeSuggestions?: boolean;
}

const ERR_SUGGESTION_TYPES: ReadonlySet<string> = new Set(['word_choice', 'expression', 'rhetoric']);
const oneLine = (s?: string) => (s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const summarizeTitle = (s?: string) => {
  const clean = oneLine(s);
  return clean.length > 36 ? `${clean.slice(0, 36)}…` : clean;
};
const MAX_ITEMS = 30;

export function classifyEssayMistakeItems(rawGrading: string): {
  errors: ClassifiedEssayMistakeItem[];
  suggestions: ClassifiedEssayMistakeItem[];
  all: ClassifiedEssayMistakeItem[];
} {
  const t = (key: string, options?: Record<string, unknown>) =>
    i18next.t(`essay_grading:mistakes.${key}`, options ?? {}) as string;
  const subject = t('tag', { defaultValue: '作文' });
  const seen = new Set<string>();
  const errors: ClassifiedEssayMistakeItem[] = [];
  const suggestions: ClassifiedEssayMistakeItem[] = [];
  const all: ClassifiedEssayMistakeItem[] = [];

  for (const marker of parseStreamingContent(rawGrading, true).markers) {
    let item: ClassifiedEssayMistakeItem | null = null;
    if (marker.type === 'replace' && oneLine(marker.oldText)) {
      const oldText = oneLine(marker.oldText);
      item = {
        category: 'suggestion',
        title: summarizeTitle(oldText),
        draft: {
          content: t('replace_prompt', {
            defaultValue: '改正下列句子中的问题：\n{{text}}',
            text: oldText,
          }),
          answer: oneLine(marker.newText) || undefined,
          explanation: oneLine(marker.reason) || undefined,
          tags: [subject, t('replace_tag', { defaultValue: '改写' })],
        },
      };
    } else if (marker.type === 'err' && oneLine(marker.content)) {
      const typeLabel = marker.errorType
        ? (i18next.t(`essay_grading:markers.error.${marker.errorType}`, {
            defaultValue: marker.errorType,
          }) as string)
        : t('error_tag', { defaultValue: '错误' });
      const rawExplanation = oneLine(marker.explanation);
      const answer = rawExplanation
        ? t('error_answer', {
            defaultValue: '{{type}}：{{explanation}}',
            type: typeLabel,
            explanation: rawExplanation,
          })
        : typeLabel;
      const isSuggestion = Boolean(marker.errorType && ERR_SUGGESTION_TYPES.has(marker.errorType));
      const text = oneLine(marker.content);
      item = {
        category: isSuggestion ? 'suggestion' : 'error',
        title: summarizeTitle(text),
        draft: {
          content: t('error_prompt', {
            defaultValue: '指出并改正下列内容中的错误：\n{{text}}',
            text,
          }),
          answer,
          explanation: rawExplanation || typeLabel,
          // 错误类型放首位：掌握度按首个标签归类知识点
          tags: [typeLabel, subject],
        },
      };
    } else if (marker.type === 'del' && oneLine(marker.content)) {
      const text = oneLine(marker.content);
      const reason = oneLine(marker.reason);
      item = {
        category: 'error',
        title: summarizeTitle(text),
        draft: {
          content: t('error_prompt', {
            defaultValue: '指出并改正下列内容中的错误：\n{{text}}',
            text,
          }),
          answer: reason || t('error_tag', { defaultValue: '错误' }),
          explanation: reason || undefined,
          tags: [t('error_tag', { defaultValue: '错误' }), subject],
        },
      };
    }

    if (item && !seen.has(item.draft.content)) {
      seen.add(item.draft.content);
      all.push(item);
      if (item.category === 'error') {
        errors.push(item);
      } else {
        suggestions.push(item);
      }
    }
    if (all.length >= MAX_ITEMS) break;
  }

  return { errors, suggestions, all };
}

export function buildEssayMistakeDrafts(
  rawGrading: string,
  options: BuildEssayMistakeOptions = {},
): EssayMistakeDraft[] {
  const includeSuggestions = options.includeSuggestions ?? true;
  const classified = classifyEssayMistakeItems(rawGrading);
  const items = includeSuggestions ? classified.all : classified.errors;
  return items.map((item) => item.draft);
}
