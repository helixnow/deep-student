import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  Pen,
  Cards,
  Copy,
  Check,
  Download,
  Notebook,
  WarningCircle,
  ArrowClockwise,
  CircleNotch,
  CaretLeft,
  CaretRight,
} from '@phosphor-icons/react';
import { GradingStreamRenderer } from '../../essay-grading/GradingStreamRenderer';
import type { SuggestionChange } from '../../essay-grading/suggestionAnchors';
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
  /** 应用批注中的修改建议到输入区（由 Workbench 提供，前后文锚定） */
  onApplySuggestion?: (change: SuggestionChange) => void;
  /** 撤销已采纳的建议 */
  onUndoSuggestion?: (change: SuggestionChange) => void;
  /** 已采纳建议的稳定 key 集合 */
  appliedSuggestionKeys?: ReadonlySet<string>;
  /** 把当前轮批改结果存为笔记 */
  onSaveAsNote?: () => void;
  /** 把批改结果送进制卡链路（由 Workbench 提供） */
  onGenerateCards?: () => void;
  isGeneratingCards?: boolean;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onSelect?: (index: number) => void;
  };
}

type GradingPhase = 'preparing' | 'annotating' | 'scoring' | 'polishing' | 'model_essay';

/** 根据已生成内容推断当前批改阶段（批注 → 评分 → 润色 → 范文） */
function inferGradingPhase(content: string): GradingPhase {
  if (!content) return 'preparing';
  if (/<section-model-essay/i.test(content)) return 'model_essay';
  if (/<section-polish/i.test(content)) return 'polishing';
  if (/<score\b/i.test(content)) return 'scoring';
  return 'annotating';
}

/** 错误/部分结果统一使用的细边框语义色条 */
const StatusBanner: React.FC<{
  tone: 'warning' | 'error';
  title: string;
  description?: string;
  children?: React.ReactNode;
}> = ({ tone, title, description, children }) => (
  <div
    className={cn(
      'mx-4 mt-3 rounded-md border px-3 py-2.5',
      tone === 'warning'
        ? 'border-warning/30 bg-warning/5'
        : 'border-destructive/30 bg-destructive/5'
    )}
  >
    <div className="flex items-start gap-2">
      <WarningCircle
        size={15}
        className={cn('mt-0.5 shrink-0', tone === 'warning' ? 'text-warning' : 'text-destructive')}
      />
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-sm font-medium',
            tone === 'warning' ? 'text-warning' : 'text-destructive'
          )}
        >
          {title}
        </div>
        {description && (
          <div className="text-xs text-muted-foreground mt-1 break-words leading-relaxed">
            {description}
          </div>
        )}
        {children}
      </div>
    </div>
  </div>
);

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
  onApplySuggestion,
  onUndoSuggestion,
  appliedSuggestionKeys,
  onSaveAsNote,
  onGenerateCards,
  isGeneratingCards,
  roundNavigation,
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  // 复制成功就地反馈：图标切换为 Check，1.5s 后还原
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, []);
  const handleCopy = () => {
    onCopyResult();
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  const gradingPhase = useMemo(
    () => (isGrading ? inferGradingPhase(gradingResult) : null),
    [isGrading, gradingResult]
  );

  const showEmptyState = !gradingResult && !isGrading && !error;
  // 无批改结果 / 批改进行中都没有可提炼的错点，按钮 disabled 并说明原因
  const generateCardsDisabledReason = isGrading
    ? t('essay_grading:make_cards.disabled_grading')
    : !gradingResult
      ? t('essay_grading:make_cards.disabled_no_result')
      : null;

  return (
    <div className="flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 overflow-hidden transition-all duration-200 group/target">
      {/* Toolbar - 简洁风格 */}
      <div className="flex h-[41px] shrink-0 items-center justify-between border-b border-border/30 px-3 [@media(pointer:coarse)]:h-11 sm:px-4">
        <div className="flex items-center gap-3 min-w-0">
          {/* 标题 - 简洁风格简洁 */}
          <div className="flex items-center gap-2 text-sm text-foreground/70 shrink-0">
            <Pen size={14} />
            <span>{t('essay_grading:result_section.title')}</span>
          </div>
          
          {currentRound > 0 && (
            <div className="flex items-center gap-0.5 shrink-0">
              {roundNavigation && roundNavigation.total > 1 && (
                <DsButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onPrev} disabled={roundNavigation.currentIndex <= 0} className="md:hidden !h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11">
                  <CaretLeft size={12} />
                </DsButton>
              )}
              <span className="text-xs text-muted-foreground/60 tabular-nums">
                {roundNavigation && roundNavigation.total > 1 ? (
                  <>
                    <span className="md:hidden">{t('essay_grading:round.label_fraction', { current: currentRound, total: roundNavigation.total })}</span>
                    <span className="hidden md:inline">{t('essay_grading:round.label', { number: currentRound })}</span>
                  </>
                ) : (
                  t('essay_grading:round.label', { number: currentRound })
                )}
              </span>
              {roundNavigation && roundNavigation.total > 1 && (
                <DsButton variant="ghost" size="icon" iconOnly onClick={roundNavigation.onNext} disabled={roundNavigation.currentIndex >= roundNavigation.total - 1} className="md:hidden !h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11">
                  <CaretRight size={12} />
                </DsButton>
              )}
            </div>
          )}
          
          {/* 流式进度反馈：spinner + 阶段感文案 + 已生成字数 */}
          {isGrading && gradingPhase && (
            <div className="flex items-center gap-1.5 text-xs text-primary/70 min-w-0 truncate">
              <CircleNotch size={12} className="animate-spin motion-reduce:animate-none shrink-0" />
              <span className="truncate">{t(`essay_grading:progress.phase_${gradingPhase}`)}</span>
              {charCount > 0 && (
                <span className="text-muted-foreground/50 tabular-nums whitespace-nowrap">
                  · {t('essay_grading:progress.chars_generated', { count: charCount })}
                </span>
              )}
            </div>
          )}
        </div>

        {/* 操作按钮 - 常显弱化，避免 hover 才可发现 */}
        <div className="flex items-center gap-1">
          {gradingResult && (
            <>
              <CommonTooltip content={copied ? t('essay_grading:result_section.copied_feedback') : t('essay_grading:result_section.copy')}>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={handleCopy}
                  className="!h-7 !w-7 text-muted-foreground/50 transition-colors duration-150 hover:bg-[var(--interactive-hover)] hover:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                  aria-label={t('essay_grading:result_section.copy')}
                >
                  {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                </DsButton>
              </CommonTooltip>
              {onSaveAsNote && !isGrading && (
                <CommonTooltip content={t('essay_grading:result_section.save_as_note')}>
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    onClick={onSaveAsNote}
                    className="!h-7 !w-7 text-muted-foreground/50 transition-colors duration-150 hover:bg-[var(--interactive-hover)] hover:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                    aria-label={t('essay_grading:result_section.save_as_note')}
                  >
                    <Notebook size={14} />
                  </DsButton>
                </CommonTooltip>
              )}
              <CommonTooltip content={t('essay_grading:result_section.export')}>
                <DsButton
                  variant="ghost"
                  size="icon"
                  iconOnly
                  onClick={onExportResult}
                  className="!h-7 !w-7 text-muted-foreground/50 transition-colors duration-150 hover:bg-[var(--interactive-hover)] hover:text-foreground motion-reduce:transition-none [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                  aria-label={t('essay_grading:result_section.export')}
                >
                  <Download size={14} />
                </DsButton>
              </CommonTooltip>
            </>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 flex flex-col relative" ref={ref}>
        {isPartialResult && gradingResult && !isGrading && !error && (
          <StatusBanner
            tone="warning"
            title={t('essay_grading:partial_result.label')}
            description={t('essay_grading:partial_result.hint')}
          />
        )}
        {/* 错误提示 - 细边框语义色条 */}
        {error && !isGrading && (
          <StatusBanner
            tone="error"
            title={t('essay_grading:errors.grading_failed')}
            description={error}
          >
            {canRetry && onRetry && (
              <DsButton variant="default" size="sm" onClick={onRetry} className="mt-2.5 text-xs text-foreground/80 hover:text-foreground border border-border/50 hover:bg-[var(--interactive-hover)] [@media(pointer:coarse)]:!min-h-11">
                <ArrowClockwise size={12} />
                {t('essay_grading:actions.retry')}
              </DsButton>
            )}
          </StatusBanner>
        )}

        {showEmptyState ? (
          /* 空状态 - 未开始批改时的居中引导 */
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center select-none">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border/40 bg-muted/20">
              <Pen size={18} className="text-muted-foreground/50" />
            </div>
            <div className="text-sm text-muted-foreground/80">
              {t('essay_grading:result_empty.title')}
            </div>
            <div className="text-xs text-muted-foreground/50 leading-relaxed max-w-[260px]">
              {t('essay_grading:result_empty.description')}
            </div>
          </div>
        ) : (
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
              onApplySuggestion={onApplySuggestion}
              onUndoSuggestion={onUndoSuggestion}
              appliedSuggestionKeys={appliedSuggestionKeys}
            />
          </div>
        )}

        {/* Floating Status Bar - 简洁风格（流式中字数已在顶栏显示，避免重复） */}
        {gradingResult && !isGrading && (
          <div className="absolute bottom-3 right-4 flex items-center pointer-events-none opacity-0 group-hover/target:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity duration-200 motion-reduce:transition-none">
            <span className="text-xs text-muted-foreground/50 tabular-nums">
              {charCount} {t('essay_grading:stats.characters')}
            </span>
          </div>
        )}
      </div>

      {/* 生成卡片：常显次级动作条（移动端整行，桌面右对齐），不藏进 hover 层 */}
      {onGenerateCards && !showEmptyState && (
        <div className="shrink-0 border-t border-border/30 px-3 py-2 sm:px-4">
          <DsButton
            variant="secondary"
            size="sm"
            onClick={onGenerateCards}
            disabled={Boolean(generateCardsDisabledReason) || Boolean(isGeneratingCards)}
            title={generateCardsDisabledReason ?? undefined}
            className="w-full justify-center sm:ml-auto sm:w-auto [@media(pointer:coarse)]:!min-h-[44px]"
          >
            <Cards size={14} />
            {isGeneratingCards
              ? t('essay_grading:make_cards.running')
              : t('essay_grading:make_cards.label')}
          </DsButton>
          {generateCardsDisabledReason && (
            <p className="mt-1.5 text-xs text-muted-foreground sm:text-right">
              {generateCardsDisabledReason}
            </p>
          )}
        </div>
      )}
    </div>
  );
});

ResultPanel.displayName = 'ResultPanel';
