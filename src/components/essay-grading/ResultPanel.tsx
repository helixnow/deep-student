import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  PenLine,
  Copy,
  Download,
  AlertCircle,
  RefreshCw,
  Loader2,
} from 'lucide-react';
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
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  return (
    <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 transition-all duration-200 group/target">
      {/* Toolbar - Notion 风格 */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border/30">
        <div className="flex items-center gap-3">
          {/* 标题 - Notion 风格简洁 */}
          <div className="flex items-center gap-2 text-sm text-foreground/70">
            <PenLine className="w-3.5 h-3.5" />
            <span>{t('essay_grading:result_section.title')}</span>
          </div>
          
          {currentRound > 0 && (
            <span className="text-xs text-muted-foreground/60 tabular-nums">
              {t('essay_grading:round.label', { number: currentRound })}
            </span>
          )}
          
          {/* 流式状态指示 - Notion 风格 */}
          {isGrading && (
            <div className="flex items-center gap-1.5 text-xs text-primary/70">
              <Loader2 className="h-3 w-3 animate-spin" />
            </div>
          )}
        </div>

        {/* 操作按钮 - Notion 风格悬浮显示 */}
        <div className="flex items-center gap-1 opacity-0 group-hover/target:opacity-100 transition-opacity duration-200">
          {gradingResult && (
            <>
              <CommonTooltip content={t('essay_grading:result_section.copy')}>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={onCopyResult} className="!h-7 !w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50" aria-label="copy">
                  <Copy className="w-3.5 h-3.5" />
                </NotionButton>
              </CommonTooltip>
              <CommonTooltip content={t('essay_grading:result_section.export')}>
                <NotionButton variant="ghost" size="icon" iconOnly onClick={onExportResult} className="!h-7 !w-7 text-muted-foreground/60 hover:text-foreground hover:bg-muted/50" aria-label="export">
                  <Download className="w-3.5 h-3.5" />
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
              <AlertCircle className="w-4 h-4 text-amber-500/70 shrink-0 mt-0.5" />
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
              <AlertCircle className="w-4 h-4 text-red-500/70 shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-red-600 dark:text-red-400 text-sm">
                  {t('essay_grading:errors.grading_failed')}
                </div>
                <div className="text-xs text-muted-foreground mt-1.5 break-words leading-relaxed">
                  {error}
                </div>
                {canRetry && onRetry && (
                  <NotionButton variant="default" size="sm" onClick={onRetry} className="mt-3 text-xs text-foreground/80 hover:text-foreground border border-border/50 hover:bg-muted/50">
                    <RefreshCw className="w-3 h-3" />
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
