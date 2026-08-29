import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkle } from '@phosphor-icons/react';
import { GenerativeUIPanel } from '@/features/generative-ui/components/GenerativeUIPanel';
import { buildNoteSummaryIntent } from '@/features/generative-ui/utils/buildNoteSummaryIntent';
import { cn } from '@/lib/utils';

export interface NotesGenerativeSummaryProps {
  title?: string;
  tags?: string[];
  content?: string;
  headingLabels?: string[];
  updatedAt?: string;
  className?: string;
}

/**
 * Notes 上下文面板 — 只读生成式 UI 摘要（确定性，不写入笔记）
 */
export function NotesGenerativeSummary({
  title,
  tags,
  content,
  headingLabels,
  updatedAt,
  className,
}: NotesGenerativeSummaryProps) {
  const { t, i18n } = useTranslation(['notes', 'generativeUi']);

  const intent = useMemo(() => {
    const charCount = content?.length ?? 0;
    const updatedAtLabel = updatedAt
      ? new Date(updatedAt).toLocaleDateString(i18n.language, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
        })
      : undefined;

    return buildNoteSummaryIntent({
      title: title || t('notes:context.select_hint'),
      tags,
      headingCount: headingLabels?.length ?? 0,
      charCount,
      updatedAtLabel,
      topHeadings: headingLabels,
      labels: {
        defaultTitle: t('generativeUi:notes.summary_default_title'),
        updatedPrefix: t('generativeUi:notes.summary_updated_prefix'),
        headingStatTitle: t('generativeUi:notes.summary_heading_stat'),
        overviewTitle: t('generativeUi:notes.summary_overview_title'),
        charCountKey: t('generativeUi:notes.summary_char_count'),
        tagsKey: t('generativeUi:notes.summary_tags'),
        tagsEmpty: t('generativeUi:notes.summary_tags_empty'),
        headingsTitle: t('generativeUi:notes.summary_headings_title'),
        updatedAtKey: t('generativeUi:notes.summary_updated_at'),
        emptyNoteTitle: t('generativeUi:notes.summary_empty_note_title'),
        emptyNoteDescription: t('generativeUi:notes.summary_empty_note_description'),
        emptyHeadings: t('generativeUi:notes.summary_empty_headings'),
        markdownOverviewTitle: t('generativeUi:notes.summary_markdown_title'),
      },
    });
  }, [content, headingLabels, i18n.language, tags, title, updatedAt, t]);

  if (!title && !content) {
    return null;
  }

  return (
    <div className={cn('px-3 py-2 space-y-2', className)} data-notes-generative-summary>
      <h3 className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Sparkle className="w-3.5 h-3.5 text-primary" weight="fill" aria-hidden />
        {t('generativeUi:notes.summary_title')}
      </h3>
      <GenerativeUIPanel intent={intent} showChrome={false} />
    </div>
  );
}
