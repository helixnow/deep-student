/**
 * 媒体视图工具栏的「生成讲义」入口：生成中显示阶段进度 + 取消；完成后可打开笔记。
 * 需要已完成的转写（hasTranscript=false 时禁用并提示先转写）。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, Notebook, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import { openHandoutNote, useGenerateHandout, type UseGenerateHandoutOptions } from './useGenerateHandout';
import type { HandoutProgress } from './pipeline';

export interface HandoutGenerateButtonProps extends UseGenerateHandoutOptions {
  /** 转写已有完成段（讲义的前提） */
  hasTranscript: boolean;
  className?: string;
}

const coarse = '[@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!min-w-11';

export function progressPercent(p: HandoutProgress | null): number | null {
  if (!p || p.total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((p.done / p.total) * 100)));
}

export const HandoutGenerateButton: React.FC<HandoutGenerateButtonProps> = ({
  hasTranscript,
  className,
  ...options
}) => {
  const { t } = useTranslation(['learningHub']);
  const { running, progress, result, start, cancel } = useGenerateHandout(options);

  if (running) {
    const pct = progressPercent(progress);
    return (
      <div
        className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <CircleNotch size={14} className="shrink-0 animate-spin text-primary motion-reduce:animate-none" aria-hidden="true" />
        <span className="truncate">
          {t(`learningHub:mediaHandout.phase.${progress?.phase ?? 'transcript'}`)}
        </span>
        {pct !== null && progress && progress.total > 1 && (
          <span className="shrink-0 tabular-nums">{`${progress.done}/${progress.total}`}</span>
        )}
        <DsButton
          variant="ghost"
          size="sm"
          iconOnly
          onClick={cancel}
          aria-label={t('learningHub:mediaHandout.cancel')}
          title={t('learningHub:mediaHandout.cancel')}
          className="h-7 w-7 shrink-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
        >
          <X size={13} aria-hidden="true" />
        </DsButton>
      </div>
    );
  }

  return (
    <>
      <DsButton
        variant="ghost"
        size="sm"
        onClick={start}
        disabled={!hasTranscript}
        title={hasTranscript ? t('learningHub:mediaHandout.generateHint') : t('learningHub:mediaHandout.needTranscript')}
        aria-label={t('learningHub:mediaHandout.generate')}
        className={cn('h-8 gap-1.5 px-2.5 text-xs', coarse, className)}
      >
        <Notebook size={14} aria-hidden="true" />
        <span className="max-sm:hidden">{t('learningHub:mediaHandout.generate')}</span>
      </DsButton>
      {result && (
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => openHandoutNote(result.noteId)}
          className={cn('h-8 px-2.5 text-xs text-primary', coarse)}
        >
          {t('learningHub:mediaHandout.openNote')}
        </DsButton>
      )}
    </>
  );
};
