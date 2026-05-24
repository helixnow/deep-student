import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  Pen,
  Copy,
  Download,
  WarningCircle,
  ArrowClockwise,
  CircleNotch,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react';
import { GradingStreamRenderer } from '../../essay-grading/GradingStreamRenderer';
import { cn } from '@/lib/utils';

interface ResultPanelProps {
  gradingResult: string;
  isGrading: boolean;
  charCount: number;
  onCopyResult: () => void;
  onExportResult: () => void;
  currentRound: number;
  /** 错误信息 */
  error?: string | null;
  /** 是否可以重试 */
  canRetry?: boolean;
  onRetry?: () => void;
  isPartialResult?: boolean;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
  };
}

export const ResultPanel = React.forwardRef<HTMLDivElement, ResultPanelProps>(({
  gradingResult,
  isGrading,
  charCount,
  onCopyResult,
  onExportResult,
  currentRound,
  error,
  canRetry,
  onRetry,
  isPartialResult,
  roundNavigation,
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  return (
    <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-200 group/target">
      {/* Toolbar - Notion 风格 */}
      <div className="flex h-[41px] items-center justify-between px-4 border-b border-border/30">
        <div className="flex items-center gap-3">
          {/* 标题 - Notion 风格简洁 */}
          <div className="flex items-center gap-2 text-sm text-foreground/70">
            <Pen size={14} />
            <span>{t('essay_grading:result_section.title')}</span>
          </div>
          
          {currentRound > 0 && (
            <div className="flex items-center gap-0.5">
              {roundNavigation && roundNavigation.total > 1 && (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onPrev} disabled={roundNavigation.currentIndex <= 0} className="sm:hidden !h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30">
                  <CaretLeft size={12} />
                </NotionButton>
              )}
              <span className="text-xs text-muted-foreground/60 tabular-nums">
                {roundNavigation && roundNavigation.total > 1 ? (
                  <>
                    <span className="sm:hidden">{t('essay_grading:round.label_fraction', { current: currentRound, total: roundNavigation.total })}</span>
                    <span className="hidden sm:inline">{t('essay_grading:round.label', { number: currentRound })}</span>
                  </>
                ) : (
                  t('essay_grading:round.label', { number: currentRound })
                )}
              </span>
              {roundNavigation && roundNavigation.total > 1 && (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onNext} disabled={roundNavigation.currentIndex >= roundNavigation.total - 1} className="sm:hidden !h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30">
                  <CaretRight size={12} />
                </NotionButton>
              )}
            </div>
          )}
          
          {/* 流式状态指示 - Notion 风格 */}
          {isGrading && (
            <div className="flex items-center gap-1.5 text-xs text-primary/70">
              <CircleNotch size={12} className="animate-spin" />
            </div>
          )}
        </div>

        {/* 操作按钮 - Notion 风格悬浮显示 */}
        <div className="flex items-center gap-1 opacity-0 group-hover/target:opacity-100 transition-opacity duration-200">
          {gradingResult && (
            <>
              <CommonTooltip content={t('essay_grading:result_section.copy')}>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={onCopyResult} className="!h-7 !w-7 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]" aria-label="copy">
                  <Copy size={14} />
                </NotionButton>
              </CommonTooltip>
              <CommonTooltip content={t('essay_grading:result_section.export')}>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={onExportResult} className="!h-7 !w-7 text-muted-foreground/60 hover:text-foreground hover:bg-[var(--interactive-hover)]" aria-label="export">
                  <Download size={14} />
                </NotionButton>
              </CommonTooltip>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col relative" ref={ref}>
        {isPartialResult && gradingResult && !isGrading && !error && (
          <div className="mx-4 mt-3 p-3 bg-amber-50/50 dark:bg-amber-950/20 border border-amber-200/50 dark:border-amber-800/30 rounded-md">
            <div className="flex items-start gap-2">
              <WarningCircle size={16} className="text-amber-500/70 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-amber-600 dark:text-amber-400 text-sm">
                  {t('essay_grading:partial_result.label')}
                </div>
                <div className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {t('essay_grading:partial_result.hint')}
                </div>
              </div>
            </div>
          </div>
        )}
        {/* 错误提示 - Notion 风格 */}
        {error && !isGrading && (
          <div className="mx-4 mt-4 p-4 bg-red-50/50 dark:bg-red-950/20 border border-red-200/50 dark:border-red-800/30 rounded-md">
            <div className="flex items-start gap-3">
              <WarningCircle size={16} className="text-red-500/70 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-red-600 dark:text-red-400 text-sm">
                  {t('essay_grading:errors.grading_failed')}
                </div>
                <div className="text-xs text-muted-foreground mt-1.5 break-words leading-relaxed">
                  {error}
                </div>
                {canRetry && onRetry && (
                  <NotionButton variant="default" size="sm" onClick={onRetry} className="mt-3 text-xs text-foreground/80 hover:text-foreground border border-border/50 hover:bg-[var(--interactive-hover)]">
                    <ArrowClockwise size={12} />
                    {t('essay_grading:actions.retry')}
                  </NotionButton>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden">
          <GradingStreamRenderer
            content={gradingResult}
            isStreaming={isGrading}
            placeholder={error ? '' : t('essay_grading:result_section.placeholder')}
            showStats={false}
            charCount={charCount}
            viewMode="annotated"
            hideToolbar={false}
            hideStreamingIndicator={true}
/>
        </div>

        {/* Floating Status Bar - Notion 风格 */}
        {gradingResult && (
          <div className="absolute bottom-3 right-4 flex items-center pointer-events-none opacity-0 group-hover/target:opacity-100 transition-opacity duration-200">
            <span className="text-xs text-muted-foreground/50 tabular-nums">
              {charCount} {t('essay_grading:stats.characters')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
});

ResultPanel.displayName = 'ResultPanel';
