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
import { classifyEssayMistakeItems } from './essayMistakeClassifier';
import { inferGradingPhase } from '../../essay-grading/gradingPhase';
import type { SuggestionChange } from '../../essay-grading/suggestionAnchors';
import {
  EssayRubricResultContext,
  formatStaleRubricBannerMessage,
  type StaleRubricInfo,
} from './rubricResultContext';
import { cn } from '@/lib/utils';

interface ResultPanelProps {
  gradingResult: string;
  isGrading: boolean;
  charCount: number;
  onCopyResult: () => void | boolean | Promise<void | boolean>;
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
  /** 错误点入错题本 */
  onSaveMistakes?: (options?: { includeSuggestions?: boolean }) => void;
  isSavingMistakes?: boolean;
  mistakesFeedback?: { tone: 'success' | 'info'; message: string } | null;
  onDismissMistakesFeedback?: () => void;
  roundNavigation?: {
    currentIndex: number;
    total: number;
    onPrev: () => void;
    onNext: () => void;
    onSelect?: (index: number) => void;
  };
  /** 原文收起时轮次切换只能在结果区进行：各断点都显示前后翻页 */
  navigateRoundsInHeader?: boolean;
  /** 当前批阅模式 ID：评分卡里预置模式的维度名按界面语言显示（仅展示） */
  gradingModeId?: string | null;
  /** 学生提交的原始作文文本：用于校验并区分模型私自插入的未提交文本 */
  originalText?: string | null;
  /** 评分缺失时强制重新批改回调 */
  onRegrade?: () => void;
  /** 当前展示的结果与用户新选评分标准不一致时的过期状态信息 */
  staleRubric?: StaleRubricInfo | null;
  /** 按新选择的评分标准重新批改 */
  onRegradeWithSelectedRubric?: () => void;
  /** 是否允许一键重新批改（有正文或原图） */
  canRegradeWithSelectedRubric?: boolean;
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
  onSaveMistakes,
  isSavingMistakes,
  mistakesFeedback,
  onDismissMistakesFeedback,
  roundNavigation,
  navigateRoundsInHeader = false,
  gradingModeId,
  originalText,
  onRegrade,
  staleRubric = null,
  onRegradeWithSelectedRubric,
  canRegradeWithSelectedRubric = true,
}, ref) => {
  const { t } = useTranslation(['essay_grading', 'common']);

  // 复制成功就地反馈：图标切换为 Check，1.5s 后还原
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);
  const handleCopy = async () => {
    try {
      const ok = await onCopyResult();
      if (ok === false || !mountedRef.current) return;
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // 错误通知由上层回调处理，此处不误报复制成功
    }
  };

  const gradingPhase = useMemo(
    () => (isGrading ? inferGradingPhase(gradingResult) : null),
    [isGrading, gradingResult]
  );

  // 首个字符返回前的冷静等待计时：避免学生面对空白流式区域误以为卡死
  const isWaitingFirstChunk = isGrading && charCount === 0;
  const [waitingSeconds, setWaitingSeconds] = useState(0);
  useEffect(() => {
    if (!isWaitingFirstChunk) {
      setWaitingSeconds(0);
      return;
    }
    setWaitingSeconds(0);
    const id = setInterval(() => {
      setWaitingSeconds((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [isWaitingFirstChunk]);

  const showEmptyState = !gradingResult && !isGrading && !error;
  // 有结果后标题行并入分段 Tab 行，省出一整行给正文
  const headerInTabs = Boolean(gradingResult);
  // 无批改结果 / 批改进行中都没有可提炼的错点，按钮 disabled 并说明原因
  const generateCardsDisabledReason = isGrading
    ? t('essay_grading:make_cards.disabled_grading')
    : !gradingResult
      ? t('essay_grading:make_cards.disabled_no_result')
      : null;

  const [includeSuggestionsInMistakes, setIncludeSuggestionsInMistakes] = useState(false);
  useEffect(() => {
    setIncludeSuggestionsInMistakes(false);
  }, [gradingResult]);

  const mistakeClassification = useMemo(
    () => (gradingResult ? classifyEssayMistakeItems(gradingResult) : { errors: [], suggestions: [], all: [] }),
    [gradingResult],
  );
  const eligibleMistakeCount =
    mistakeClassification.errors.length +
    (includeSuggestionsInMistakes ? mistakeClassification.suggestions.length : 0);
  const saveMistakesDisabledReason = generateCardsDisabledReason
    ? generateCardsDisabledReason
    : eligibleMistakeCount === 0
      ? t('essay_grading:mistakes.none_available', { defaultValue: '暂无可入库错误点' })
      : null;

  const hasRoundPages = Boolean(roundNavigation && roundNavigation.total > 1);
  const roundButtonClass = cn(
    !navigateRoundsInHeader && 'md:hidden essay-round-nav-inline',
    '!h-5 !w-5 text-muted-foreground/50 hover:text-foreground hover:bg-[var(--interactive-hover)] disabled:opacity-30 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11',
  );
  const roundFraction = roundNavigation
    ? t('essay_grading:round.label_fraction', { current: currentRound, total: Math.max(roundNavigation.total, currentRound) })
    : '';
  const roundMeta = currentRound > 0 ? (
    <div className="flex items-center gap-0.5 shrink-0">
      {hasRoundPages && roundNavigation && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={roundNavigation.onPrev}
          disabled={roundNavigation.currentIndex <= 0}
          aria-label={t('common:aria.previous_round')}
          className={roundButtonClass}
        >
          <CaretLeft size={12} />
        </DsButton>
      )}
      <span className="text-xs text-muted-foreground/60 tabular-nums">
        {hasRoundPages ? (
          navigateRoundsInHeader ? roundFraction : (
            <>
              <span className="essay-round-label-compact md:hidden">{roundFraction}</span>
              <span className="essay-round-label-wide hidden md:inline">{t('essay_grading:round.label', { number: currentRound })}</span>
            </>
          )
        ) : (
          t('essay_grading:round.label', { number: currentRound })
        )}
      </span>
      {hasRoundPages && roundNavigation && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={roundNavigation.onNext}
          disabled={roundNavigation.currentIndex >= roundNavigation.total - 1}
          aria-label={t('common:aria.next_round')}
          className={roundButtonClass}
        >
          <CaretRight size={12} />
        </DsButton>
      )}
    </div>
  ) : null;

  // 流式进度反馈：spinner + 阶段感文案 + 已生成字数
  const progressMeta = isGrading && gradingPhase ? (
    <div className="flex items-center gap-1.5 text-xs text-primary/70 min-w-0 truncate">
      <CircleNotch size={12} className="animate-spin motion-reduce:animate-none shrink-0" />
      <span className="truncate">{t(`essay_grading:progress.phase_${gradingPhase}`)}</span>
      {charCount > 0 && (
        <span className="text-muted-foreground/50 tabular-nums whitespace-nowrap">
          · {t('essay_grading:progress.chars_generated', { count: charCount })}
        </span>
      )}
    </div>
  ) : null;

  // 操作按钮 - 常显弱化，避免 hover 才可发现
  const resultActions = gradingResult ? (
    <div className="flex items-center gap-1">
      <CommonTooltip content={copied ? t('essay_grading:result_section.copied_feedback') : t('essay_grading:result_section.copy')}>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={() => { void handleCopy(); }}
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
    </div>
  ) : null;

  const banners = (
    <>
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
    </>
  );

  const activeStaleRubric = !isGrading && gradingResult ? staleRubric : null;
  const rubricContextValue = useMemo(
    () => ({ staleRubric: activeStaleRubric }),
    [activeStaleRubric],
  );
  const staleBannerMessage = useMemo(
    () => (activeStaleRubric ? formatStaleRubricBannerMessage(activeStaleRubric, t) : null),
    [activeStaleRubric, t],
  );
  const handleStaleRegrade = onRegradeWithSelectedRubric ?? onRegrade ?? onRetry;

  return (
    <div className="essay-result-pane flex flex-col h-full min-h-0 flex-1 basis-1/2 min-w-0 overflow-hidden transition-all duration-200 motion-reduce:transition-none">
      {!headerInTabs && (
        <div className="flex h-[41px] shrink-0 items-center justify-between border-b border-border/35 px-3 [@media(pointer:coarse)]:h-11 sm:px-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center gap-2 text-sm text-foreground/70 shrink-0">
              <Pen size={14} />
              <span>{t('essay_grading:result_section.title')}</span>
            </div>
            {roundMeta}
            {progressMeta}
          </div>
        </div>
      )}

      {/* S3-02: 评分标准变更后，在评分/结果区正上方展示高对比度过期提示条与一键重批入口 */}
      {activeStaleRubric && staleBannerMessage && (
        <div
          data-testid="essay-stale-rubric-banner"
          role="status"
          aria-live="polite"
          className="mx-3 mt-2.5 mb-1.5 sm:mx-4 shrink-0 rounded-lg border border-warning/45 bg-warning/10 px-3.5 py-2.5 shadow-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-2.5">
            <div className="flex min-w-0 flex-1 items-start gap-2">
              <WarningCircle
                size={16}
                weight="fill"
                className="mt-0.5 shrink-0 text-warning"
                aria-hidden="true"
              />
              <p className="min-w-0 text-xs sm:text-sm font-medium leading-relaxed text-foreground break-words">
                {staleBannerMessage}
              </p>
            </div>
            {handleStaleRegrade && (
              <DsButton
                type="button"
                variant="primary"
                size="sm"
                data-testid="essay-regrade-with-selected-rubric"
                onClick={handleStaleRegrade}
                disabled={!canRegradeWithSelectedRubric || isGrading}
                className="h-8 shrink-0 gap-1.5 px-3 text-xs font-medium shadow-sm [@media(pointer:coarse)]:!min-h-11"
              >
                <ArrowClockwise size={13} className="shrink-0" />
                {t('essay_grading:stale_rubric.regrade_cta', { defaultValue: '按新标准重新批改' })}
              </DsButton>
            )}
          </div>
        </div>
      )}

      {/* Content */}
      <EssayRubricResultContext.Provider value={rubricContextValue}>
      <div className="flex-1 min-h-0 flex flex-col relative" ref={ref}>
        {!headerInTabs && banners}

        {isWaitingFirstChunk ? (
          <div
            data-testid="essay-grading-waiting-card"
            role="status"
            aria-live="polite"
            className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center select-none ui-rise-in motion-reduce:animate-none"
          >
            <CircleNotch size={20} className="animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
            <div className="text-sm font-medium text-foreground/85">
              {gradingPhase ? t(`essay_grading:progress.phase_${gradingPhase}`) : t('essay_grading:progress.phase_annotating')}
            </div>
            <p className="text-xs text-muted-foreground/80 leading-relaxed max-w-xs">
              {waitingSeconds >= 8
                ? t('essay_grading:progress.waiting_deep_hint')
                : t('essay_grading:progress.waiting_calm_hint')}
            </p>
            {waitingSeconds > 0 && (
              <span className="rounded-full border border-border/40 bg-muted/30 px-2.5 py-0.5 font-mono text-2xs tabular-nums text-muted-foreground">
                {t('essay_grading:progress.elapsed_seconds', { seconds: waitingSeconds })}
              </span>
            )}
          </div>
        ) : showEmptyState ? (
          /* 空状态 - 未开始批改时的居中引导 */
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-3 px-6 text-center select-none">
            <Pen size={20} className="text-muted-foreground/50" aria-hidden="true" />
            <div className="text-sm text-muted-foreground/80">
              {t('essay_grading:result_empty.title')}
            </div>
            <div className="text-xs text-muted-foreground/50 leading-relaxed max-w-[260px]">
              {t('essay_grading:result_empty.description')}
            </div>
            <p className="text-xs text-muted-foreground">
              {t('essay_grading:empty_state.deliverables_hint')}
            </p>
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
              gradingModeId={gradingModeId}
              originalText={originalText}
              onRetry={onRegrade ?? onRetry}
              toolbarAccessory={headerInTabs ? (
                <div className="essay-result-accessory-inner flex min-w-0 flex-1 flex-wrap items-center justify-end gap-1.5 sm:flex-initial sm:flex-nowrap sm:gap-2">
                  {progressMeta}
                  {roundMeta}
                  {resultActions}
                </div>
              ) : undefined}
              banner={headerInTabs ? banners : undefined}
            />
          </div>
        )}
      </div>
      </EssayRubricResultContext.Provider>

      {/* 生成卡片与入错题本：收进底部紧凑单行（禁用原因走 title 提示，不额外撑高第二行说明文字） */}
      {(onGenerateCards || onSaveMistakes) && !showEmptyState && (
        <div
          className="shrink-0 border-t border-border/25 px-3 py-1.5 sm:px-4"
          style={{ paddingBottom: 'calc(0.375rem + var(--wb-dock-clearance, 0px))' }}
        >
          {mistakesFeedback && (
            <div
              data-testid="essay-mistakes-feedback-banner"
              role="status"
              className={cn(
                'mb-1.5 flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5 text-xs',
                mistakesFeedback.tone === 'success'
                  ? 'border-success/30 bg-success/10 text-foreground'
                  : 'border-border/40 bg-muted/40 text-muted-foreground',
              )}
            >
              <span className="min-w-0 break-words">{mistakesFeedback.message}</span>
              {onDismissMistakesFeedback && (
                <button
                  type="button"
                  onClick={onDismissMistakesFeedback}
                  aria-label={t('common:close', { defaultValue: '关闭' })}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  ×
                </button>
              )}
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
          {onSaveMistakes && !isGrading && gradingResult && mistakeClassification.suggestions.length > 0 && (
            <label className="mr-auto inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
              <input
                type="checkbox"
                checked={includeSuggestionsInMistakes}
                onChange={(e) => setIncludeSuggestionsInMistakes(e.target.checked)}
                data-testid="essay-include-suggestions-checkbox"
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              <span>
                {t('essay_grading:mistakes.include_suggestions', {
                  count: mistakeClassification.suggestions.length,
                  defaultValue: `同时收录改写建议 (${mistakeClassification.suggestions.length})`,
                })}
              </span>
            </label>
          )}
          {onSaveMistakes && !isGrading && gradingResult && eligibleMistakeCount === 0 && (
            <span
              data-testid="essay-mistakes-empty-hint"
              className="text-[11px] text-muted-foreground/80"
            >
              {t('essay_grading:mistakes.none_available', { defaultValue: '暂无可入库错误点' })}
            </span>
          )}
          {onSaveMistakes && (
            <DsButton
              variant="secondary"
              size="sm"
              data-testid="essay-save-mistakes-button"
              onClick={() => onSaveMistakes({ includeSuggestions: includeSuggestionsInMistakes })}
              disabled={Boolean(saveMistakesDisabledReason) || Boolean(isSavingMistakes)}
              title={saveMistakesDisabledReason ?? undefined}
              className="[@media(pointer:coarse)]:!min-h-[44px]"
            >
              <Notebook size={14} />
              {isSavingMistakes
                ? t('essay_grading:mistakes.running')
                : t('essay_grading:mistakes.label')}
            </DsButton>
          )}
          {onGenerateCards && (
          <DsButton
            variant="secondary"
            size="sm"
            onClick={onGenerateCards}
            disabled={Boolean(generateCardsDisabledReason) || Boolean(isGeneratingCards)}
            title={generateCardsDisabledReason ?? undefined}
            className="[@media(pointer:coarse)]:!min-h-[44px]"
          >
            <Cards size={14} />
            {isGeneratingCards
              ? t('essay_grading:make_cards.running')
              : t('essay_grading:make_cards.label')}
          </DsButton>
          )}
          </div>
        </div>
      )}
    </div>
  );
});

ResultPanel.displayName = 'ResultPanel';
