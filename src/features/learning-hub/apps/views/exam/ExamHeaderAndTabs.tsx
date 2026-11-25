import React, { useState, useLayoutEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CircleNotch,
  CheckCircle,
  ArrowClockwise,
  Scan,
  Clock,
  Play,
  Pause,
  ArrowClockwise as RotateCw,
  Download,
  Plus,
  CaretDown,
  PencilSimple,
  Table as TableIcon,
  Sparkle,
  DotsSixVertical,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { AppSelect, AppMenu, AppMenuTrigger, AppMenuContent, AppMenuItem, AppMenuSeparator } from '@/components/ui/app-menu';
import { QBankAgentDiffBar } from '@/components/practice/QBankAgentDiffBar';
import { cn } from '@/utils/cn';
import { formatTime } from '@/utils/formatUtils';
import type { PracticeMode, Question, QuestionBankStats } from '@/api/questionBankApi';
import type { GradingMode } from '@/api/practiceApi';
import type { PendingAuthoringDraftView, QbankGenerationTask } from '@/types/qbankGeneration';
import type { deriveQuestionExcerptMeta } from '../examQuestionInterop';
import {
  StatsSummary,
  type PendingDraftNavigation,
  type PendingViewNavigation,
  type SecondaryTabItem,
  type ViewMode,
} from './ExamViewPrimitives';

export interface ExamHeaderAndTabsProps {
  sessionId: string;
  readOnly: boolean;
  isSmallScreen: boolean;
  isLoading: boolean;
  hasQuestions: boolean;
  questionsCount: number;
  stats?: QuestionBankStats;
  viewMode: ViewMode;
  gradingMode: GradingMode;
  practiceMode: PracticeMode;
  modeOptions: Array<{ value: string; label: string }>;
  secondaryTabs: SecondaryTabItem[];
  sm2DueCount: number;
  isImportingSession: boolean;
  isResuming: boolean;
  resumeError: string | null;
  error: string | null;
  isAdvancedRuntimeTimer: boolean;
  advancedTimerRemaining: number | null;
  elapsedTime: number;
  isTimerRunning: boolean;
  onToggleTimer: () => void;
  activeQuestionId: string | null;
  activeDragQuestion: Question | null;
  activeDragQuestionIndex: number;
  activeDragQuestionMeta: ReturnType<typeof deriveQuestionExcerptMeta> | null;
  onQuestionDragStart: (event: React.DragEvent, question: Question, questionIndex?: number) => void;
  onRequestViewMode: (mode: ViewMode, afterViewChange?: () => void, changesPractice?: boolean) => boolean;
  onSelectMode: (value: string) => void;
  onResumeImport: () => void;
  onRetryQuestions: () => void;
  onOpenExport: () => void;
  onCreateQuestionEntry: () => void;
  onOpenAiGeneration: () => void;
  onOpenUploadEntry: () => void;
  onOpenCsvImport: () => void;
  onOpenImportAudit: () => void;
  pendingReviewExitView: PendingViewNavigation | null;
  onCancelReviewExit: () => void;
  onConfirmReviewExit: () => void;
  pendingPracticeExitView: PendingViewNavigation | null;
  onCancelPracticeExit: () => void;
  onConfirmPracticeExit: () => void;
  pendingDraftNavigation: PendingDraftNavigation | null;
  onCancelDiscardDraft: () => void;
  onConfirmDiscardDraft: () => void;
  activeGenerationTask: QbankGenerationTask | null;
  onOpenGenerationProgress: () => void;
  pendingAuthoringDrafts: PendingAuthoringDraftView[];
  confirmingDraftJobId: string | null;
  onConfirmPendingDraft: (draft: PendingAuthoringDraftView) => void;
  onReviewPendingDraft: (draft: PendingAuthoringDraftView) => void;
  onRevertQuestions: (targets: Question[]) => Promise<void>;
  onFocusQuestionById: (questionId: string) => void;
}

export const ExamHeaderAndTabs: React.FC<ExamHeaderAndTabsProps> = ({
  sessionId,
  readOnly,
  isSmallScreen,
  isLoading,
  hasQuestions,
  questionsCount,
  stats,
  viewMode,
  gradingMode,
  practiceMode,
  modeOptions,
  secondaryTabs,
  sm2DueCount,
  isImportingSession,
  isResuming,
  resumeError,
  error,
  isAdvancedRuntimeTimer,
  advancedTimerRemaining,
  elapsedTime,
  isTimerRunning,
  onToggleTimer,
  activeQuestionId,
  activeDragQuestion,
  activeDragQuestionIndex,
  activeDragQuestionMeta,
  onQuestionDragStart,
  onRequestViewMode,
  onSelectMode,
  onResumeImport,
  onRetryQuestions,
  onOpenExport,
  onCreateQuestionEntry,
  onOpenAiGeneration,
  onOpenUploadEntry,
  onOpenCsvImport,
  onOpenImportAudit,
  pendingReviewExitView,
  onCancelReviewExit,
  onConfirmReviewExit,
  pendingPracticeExitView,
  onCancelPracticeExit,
  onConfirmPracticeExit,
  pendingDraftNavigation,
  onCancelDiscardDraft,
  onConfirmDiscardDraft,
  activeGenerationTask,
  onOpenGenerationProgress,
  pendingAuthoringDrafts,
  confirmingDraftJobId,
  onConfirmPendingDraft,
  onReviewPendingDraft,
  onRevertQuestions,
  onFocusQuestionById,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common', 'learningHub', 'review']);

  // 当前是否处于「更多」菜单中的二级视图（用于菜单触发器的高亮与文案）
  const activeSecondaryTab = secondaryTabs.find((tab) => tab.mode === viewMode);

  // ========== Tab 栏滑动选中指示器 + 方向键可达 ==========
  const tabListRef = useRef<HTMLDivElement | null>(null);
  const [tabIndicator, setTabIndicator] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  // 顶部一级入口的激活归属：题库 / 试卷 / 做题(含启动台) / 更多(二级视图)
  const activeTopTab: 'list' | 'practice' | 'papers' | 'more' | null =
    (viewMode === 'list' || viewMode === 'browse') ? 'list'
      : (viewMode === 'practice' || viewMode === 'launcher') ? 'practice'
        : viewMode === 'papers' ? 'papers' : activeSecondaryTab ? 'more'
          : null;

  // 指示器几何测量：布局阶段同步测量避免首帧闪跳；
  // 标签文案（语言/二级视图标题）与容器尺寸变化时重测
  useLayoutEffect(() => {
    const list = tabListRef.current;
    if (!list) return;

    const measure = () => {
      const active = list.querySelector<HTMLElement>('[data-exam-tab][data-active="true"]');
      if (!active) {
        setTabIndicator(null);
        return;
      }
      // 用 rect 差值而非 offsetLeft：「更多」按钮嵌在 AppMenu 的 relative 包裹层里，
      // offsetLeft 相对的是包裹层而不是 Tab 列表
      const listRect = list.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const next = {
        left: Math.round(activeRect.left - listRect.left + list.scrollLeft),
        top: Math.round(activeRect.top - listRect.top + list.scrollTop),
        width: Math.round(activeRect.width),
        height: Math.round(activeRect.height),
      };
      setTabIndicator((prev) => (
        prev && prev.left === next.left && prev.top === next.top
          && prev.width === next.width && prev.height === next.height
          ? prev
          : next
      ));
    };

    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(list);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [activeTopTab, activeSecondaryTab?.label, hasQuestions, t, isLoading, isResuming]);

  // 方向键在一级 Tab 之间移动焦点（Home/End 跳到首尾）
  const handleTabListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const list = tabListRef.current;
    if (!list) return;
    const tabs = Array.from(list.querySelectorAll<HTMLElement>('[data-exam-tab]'))
      .filter((el) => !el.hasAttribute('disabled'));
    if (tabs.length === 0) return;
    const current = document.activeElement instanceof HTMLElement
      ? tabs.indexOf(document.activeElement)
      : -1;
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
    else if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else next = tabs.length - 1;
    tabs[next]?.focus();
  }, []);

  return (
    <>
      {/* 断点续导：importing 状态横幅 */}
      {isImportingSession && (
        <div className="flex-shrink-0 border-b border-border/40 bg-muted/50 px-3 py-2 sm:px-4">
          {/* flex-wrap：375px 下右侧「恢复导入」按钮组换行到第二行，避免把提示文案挤到不可读 */}
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" aria-hidden="true" />
              <span className="truncate text-xs text-foreground/85">
                {t('exam_sheet:uploader.import_interrupted', { count: questionsCount })}
              </span>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
              {resumeError && (
                <span className="text-xs text-destructive max-w-[200px] truncate" title={resumeError}>
                  {resumeError}
                </span>
              )}
              <DsButton
                variant="ghost"
                size="sm"
                onClick={onResumeImport}
                disabled={isResuming}
                className="h-7 gap-1.5 px-2.5 text-xs text-foreground hover:bg-foreground/[0.05]"
              >
                {isResuming ? (
                  <CircleNotch size={13} className="animate-spin" />
                ) : (
                  <RotateCw size={13} />
                )}
                {isResuming
                  ? t('exam_sheet:uploader.resuming')
                  : t('exam_sheet:uploader.resume_import')
                }
              </DsButton>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="flex-shrink-0 px-3 sm:px-4 py-2 border-b border-border/40 bg-muted/50" role="alert">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" aria-hidden="true" />
              <span className="text-xs text-foreground/85 truncate" title={error}>
                {t('exam_sheet:errors.loadQuestionsFailed')}: {error}
              </span>
            </div>
            <DsButton variant="ghost" size="sm" onClick={onRetryQuestions} className="h-7 gap-1.5 px-2.5 text-xs">
              <ArrowClockwise size={13} />
              {t('common:actions.retry')}
            </DsButton>
          </div>
        </div>
      )}

      {/* Tab 栏：收敛为干净的 min-h-11 单行导航；整卷练习（BatchPracticeWorkspace）激活时隐藏右侧管理/导出噪点 */}
      <div className="flex-shrink-0 min-h-11 px-3 py-1 sm:py-0 sm:h-11 sm:px-4 border-b border-border/35 bg-background/95 backdrop-blur-sm flex items-center">
        <div className="flex w-full items-center justify-between gap-2">
          {/* 左侧 Tab - 允许横向滚动；移动端右缘渐隐提示还有更多；方向键在一级入口间移动焦点 */}
          <div
            ref={tabListRef}
            role="toolbar"
            aria-label={t('learningHub:exam.shell.primaryNav')}
            aria-orientation="horizontal"
            onKeyDown={handleTabListKeyDown}
            className="relative flex items-center gap-1 min-w-0 overflow-x-auto overscroll-x-contain scrollbar-none max-sm:[mask-image:linear-gradient(to_right,black_calc(100%-20px),transparent)]"
          >
            {/* 滑动选中指示器（在按钮下层随激活项平移/变宽） */}
            {tabIndicator && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute z-0 rounded-lg bg-foreground/[0.06] transition-[left,top,width,height] duration-200 ease-out motion-reduce:transition-none"
                style={{
                  left: tabIndicator.left,
                  top: tabIndicator.top,
                  width: tabIndicator.width,
                  height: tabIndicator.height,
                }}
              />
            )}
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => onRequestViewMode('list')}
              data-exam-tab=""
              data-active={activeTopTab === 'list' || undefined}
              aria-pressed={activeTopTab === 'list'}
              className={cn(
                'relative z-[1] min-h-9 sm:min-h-0 px-2.5 sm:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ui-press [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                activeTopTab === 'list'
                  ? 'text-foreground font-medium hover:bg-transparent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.035]'
              )}
            >
              {t('learningHub:exam.tab.questionBank')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => onRequestViewMode('papers')}
              data-exam-tab=""
              data-active={viewMode === 'papers' || undefined}
              aria-pressed={viewMode === 'papers'}
              className={cn(
                'relative z-[1] min-h-9 sm:min-h-0 px-2.5 sm:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ui-press [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                viewMode === 'papers'
                  ? 'text-foreground font-medium hover:bg-transparent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.035]'
              )}
            >
              {t('practice:batch.papers')}
            </DsButton>
            <DsButton
              variant="ghost"
              size="sm"
              onClick={() => {
                if (viewMode !== 'practice' && viewMode !== 'launcher') {
                  onRequestViewMode('launcher');
                }
              }}
              disabled={!hasQuestions}
              data-exam-tab=""
              data-active={activeTopTab === 'practice' || undefined}
              aria-pressed={activeTopTab === 'practice'}
              className={cn(
                'relative z-[1] min-h-9 sm:min-h-0 px-2.5 sm:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 ui-press [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                activeTopTab === 'practice'
                  ? 'text-foreground font-medium hover:bg-transparent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.035]',
                !hasQuestions && 'opacity-50 cursor-not-allowed'
              )}
            >
              {t('learningHub:exam.tab.practice')}
            </DsButton>
            {/* 二级视图收纳进「更多」菜单：错题 / 复习 / 收藏 / 知识点 / 统计 / 管理 */}
            {hasQuestions && (
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    size="sm"
                    data-exam-tab=""
                    data-active={activeTopTab === 'more' || undefined}
                    aria-pressed={activeTopTab === 'more'}
                    aria-label={t('learningHub:exam.tab.more')}
                    className={cn(
                      'group relative z-[1] min-h-9 sm:min-h-0 px-2.5 sm:px-3 py-1.5 text-sm rounded-lg transition-colors whitespace-nowrap flex-shrink-0 gap-1 ui-press [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                      activeTopTab === 'more'
                        ? 'text-foreground font-medium hover:bg-transparent'
                        : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.035]'
                    )}
                  >
                    {activeSecondaryTab?.label ?? t('learningHub:exam.tab.more')}
                    {sm2DueCount > 0 && viewMode !== 'sm2' && (
                      <span
                        className="min-w-[18px] rounded-full bg-foreground/[0.06] px-1.5 py-px text-center font-mono text-2xs font-medium tabular-nums text-warning"
                        aria-hidden="true"
                      >
                        {sm2DueCount > 99 ? '99+' : sm2DueCount}
                      </span>
                    )}
                    <CaretDown
                      size={12}
                      className="opacity-60 transition-transform duration-200 ease-out motion-reduce:transition-none group-aria-expanded:rotate-180"
                    />
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="start" width={180}>
                  {secondaryTabs.map(({ mode, label, icon: Icon, badge }) => (
                    <AppMenuItem
                      key={mode}
                      onClick={() => onRequestViewMode(mode)}
                      icon={<Icon size={16} />}
                      checked={viewMode === mode}
                      suffix={badge > 0 ? (
                        <span className="min-w-[18px] rounded-full bg-foreground/[0.06] px-1.5 py-px text-center font-mono text-2xs font-medium tabular-nums text-warning">
                          {badge > 99 ? '99+' : badge}
                        </span>
                      ) : undefined}
                    >
                      {label}
                    </AppMenuItem>
                  ))}
                </AppMenuContent>
              </AppMenu>
            )}

            {viewMode === 'practice' && gradingMode === 'immediate' && hasQuestions && (
              <>
                <div className="w-px h-3.5 bg-border/45 mx-1 sm:mx-1.5 flex-shrink-0" />
                <AppSelect
                  value={practiceMode}
                  onValueChange={onSelectMode}
                  options={modeOptions}
                  size="sm"
                  variant="ghost"
                  className="h-9 sm:h-7 flex-shrink-0 border-0 bg-foreground/[0.04] px-2 text-xs hover:bg-foreground/[0.07]"
                />

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={isAdvancedRuntimeTimer ? undefined : onToggleTimer}
                  aria-disabled={isAdvancedRuntimeTimer || undefined}
                  aria-label={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause')
                        : t('learningHub:exam.timer.resume')
                  }
                  className={cn(
                    'flex min-h-9 sm:min-h-0 items-center gap-1.5 px-2.5 py-1 rounded-full bg-foreground/[0.04] transition-colors font-mono tabular-nums text-xs flex-shrink-0 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]',
                    isAdvancedRuntimeTimer && advancedTimerRemaining != null && advancedTimerRemaining <= 60
                      ? 'bg-destructive/[0.08] text-destructive hover:bg-destructive/[0.12]'
                      : isAdvancedRuntimeTimer && advancedTimerRemaining != null && advancedTimerRemaining < 300
                        ? 'bg-warning/[0.08] text-warning hover:bg-warning/[0.12]'
                        : 'text-muted-foreground hover:text-foreground hover:bg-foreground/[0.07]'
                  )}
                  title={
                    isAdvancedRuntimeTimer
                      ? t('learningHub:exam.timer.remaining')
                      : isTimerRunning
                        ? t('learningHub:exam.timer.pause')
                        : t('learningHub:exam.timer.resume')
                  }
                >
                  {isAdvancedRuntimeTimer ? (
                    <Clock size={13} />
                  ) : isTimerRunning ? (
                    <Pause size={13} />
                  ) : (
                    <Play size={13} />
                  )}
                  <span className={cn('font-mono tabular-nums text-xs', !isAdvancedRuntimeTimer && !isTimerRunning && 'opacity-65')}>
                    {formatTime(advancedTimerRemaining ?? elapsedTime)}
                  </span>
                </DsButton>
              </>
            )}
          </div>

          {/* 右侧：统计摘要 + 导出 + 添加题目菜单（整卷练习激活时隐藏右侧二级操作噪点） */}
          {!(viewMode === 'practice' && gradingMode === 'on_submit') && (
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {hasQuestions && stats && <StatsSummary stats={stats} />}
              {!isSmallScreen &&
                (viewMode === 'practice' || viewMode === 'browse') &&
                activeDragQuestion &&
                activeDragQuestionMeta && (
                  <button
                    type="button"
                    draggable
                    data-testid="exam-active-question-drag-pill"
                    onDragStart={(e) =>
                      onQuestionDragStart(e, activeDragQuestion, activeDragQuestionIndex)
                    }
                    title={t('exam_sheet:interop.dragQuestionHint', {
                      defaultValue: '将当前题目或错题拖入思维导图知识卡片',
                    })}
                    aria-label={t('exam_sheet:interop.dragQuestionHint', {
                      defaultValue: '将当前题目或错题拖入思维导图知识卡片',
                    })}
                    className="hidden md:inline-flex h-7 cursor-grab items-center gap-1 rounded-lg border border-border/35 bg-card/60 px-2 text-xs text-muted-foreground transition-colors hover:bg-foreground/[0.04] hover:text-foreground active:cursor-grabbing"
                  >
                    <DotsSixVertical size={13} aria-hidden="true" />
                    <span className="hidden md:inline">
                      {t('exam_sheet:interop.dragQuestion', { defaultValue: '拖入导图' })}
                    </span>
                    <span className="font-mono text-xs tabular-nums text-foreground/85">
                      {activeDragQuestionMeta.questionLabel}
                    </span>
                  </button>
                )}
              {hasQuestions && (
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={onOpenExport}
                  aria-label={t('learningHub:exam.tab.export')}
                  title={t('learningHub:exam.tab.export')}
                  className="h-9 sm:h-7 gap-1.5 px-2.5 sm:px-3 text-xs text-muted-foreground hover:text-foreground hover:bg-foreground/[0.04] ui-press [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]"
                >
                  <Download size={14} />
                  <span className="hidden sm:inline">{t('learningHub:exam.tab.export')}</span>
                </DsButton>
              )}
              {!readOnly && (
                <AppMenu>
                  <AppMenuTrigger asChild>
                    <DsButton
                      variant={viewMode === 'upload' ? 'default' : 'ghost'}
                      size="sm"
                      aria-label={t('learningHub:exam.tab.addQuestion')}
                      title={t('learningHub:exam.tab.addQuestion')}
                      className={cn(
                        'h-9 sm:h-7 gap-1.5 px-2.5 sm:px-3 text-xs ui-press [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
                        viewMode !== 'upload' && 'bg-foreground/[0.04] text-foreground hover:bg-foreground/[0.08]'
                      )}
                    >
                      <Plus size={14} />
                      <span className="hidden sm:inline">{t('learningHub:exam.tab.addQuestion')}</span>
                      <CaretDown size={11} className="opacity-60" />
                    </DsButton>
                  </AppMenuTrigger>
                  <AppMenuContent align="end" width={200}>
                    <AppMenuItem
                      onClick={onCreateQuestionEntry}
                      icon={<PencilSimple size={16} />}
                    >
                      {t('exam_sheet:questionBank.create.title')}
                    </AppMenuItem>
                    <AppMenuItem
                      onClick={onOpenAiGeneration}
                      icon={<Sparkle size={16} />}
                    >
                      {t('exam_sheet:aiGeneration.title')}
                    </AppMenuItem>
                    <AppMenuSeparator />
                    <AppMenuItem
                      onClick={onOpenUploadEntry}
                      icon={<Scan size={16} />}
                    >
                      {t('learningHub:exam.tab.add')}
                    </AppMenuItem>
                    <AppMenuItem
                      onClick={onOpenCsvImport}
                      icon={<TableIcon size={16} />}
                    >
                      {t('learningHub:exam.tab.importCsv')}
                    </AppMenuItem>
                    <AppMenuItem onClick={onOpenImportAudit} icon={<Scan size={16} />}>
                      {t('exam_sheet:uploader.audit_imports', { defaultValue: '导入记录与重解析复核' })}
                    </AppMenuItem>
                  </AppMenuContent>
                </AppMenu>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 行内确认条：退出复习 / 退出练习 / 丢弃草稿 */}
      {pendingReviewExitView !== null && (
        <div
          className="flex-shrink-0 border-b border-border/40 bg-muted/50 px-3 py-2 sm:px-4 ui-drop-in"
          role="alert"
          aria-label={t('review:session.exitTitle')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-foreground">{t('review:session.exitTitle')}</span>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                <span className="text-xs text-muted-foreground">{t('review:session.exitDescription')}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-1.5 ml-auto">
              <DsButton variant="ghost" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onCancelReviewExit}>
                {t('common:cancel')}
              </DsButton>
              <DsButton variant="warning" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onConfirmReviewExit}>
                {t('review:session.exitConfirm')}
              </DsButton>
            </div>
          </div>
        </div>
      )}
      {pendingPracticeExitView !== null && (
        <div
          className="flex-shrink-0 border-b border-border/40 bg-muted/50 px-3 py-2 sm:px-4 ui-drop-in"
          role="alert"
          aria-label={t('practice:session.exitTitle')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-warning" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-foreground">{t('practice:session.exitTitle')}</span>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                <span className="text-xs text-muted-foreground">{t('practice:session.exitDescription')}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-1.5 ml-auto">
              <DsButton variant="ghost" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onCancelPracticeExit}>
                {t('common:cancel')}
              </DsButton>
              <DsButton variant="warning" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onConfirmPracticeExit}>
                {t('practice:session.exitConfirm')}
              </DsButton>
            </div>
          </div>
        </div>
      )}
      {pendingDraftNavigation !== null && (
        <div
          className="flex-shrink-0 border-b border-border/40 bg-muted/50 px-3 py-2 sm:px-4 ui-drop-in"
          role="alert"
          aria-label={t('editor.discardDraftTitle')}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-destructive" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <span className="text-xs font-medium text-foreground">{t('editor.discardDraftTitle')}</span>
                <span className="mx-1.5 text-muted-foreground/40">·</span>
                <span className="text-xs text-muted-foreground">{t('editor.discardDraftDescription')}</span>
              </div>
            </div>
            <div className="flex items-center justify-end gap-1.5 ml-auto">
              <DsButton variant="ghost" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onCancelDiscardDraft}>
                {t('common:cancel')}
              </DsButton>
              <DsButton variant="danger" size="sm" className="!h-7 px-2.5 text-xs [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)]" onClick={onConfirmDiscardDraft}>
                {t('common:actions.discard')}
              </DsButton>
            </div>
          </div>
        </div>
      )}

      {!readOnly && viewMode !== 'upload' && (hasQuestions || viewMode !== 'list') && activeGenerationTask && (
        <div
          data-testid="exam-active-ai-generation-banner"
          className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-primary/25 bg-primary/[0.06] px-3 py-2 sm:px-4"
          role="status"
        >
          <CircleNotch size={14} className="shrink-0 animate-spin text-primary" aria-hidden="true" />
          <span className="min-w-0 flex-1 text-xs text-foreground">
            {t('exam_sheet:aiGeneration.backgroundRunningBanner', {
              defaultValue: 'AI 正在后台生成题目，完成后将提示您审阅并确认入库',
            })}
          </span>
          <DsButton
            size="sm"
            variant="ghost"
            className="h-9 sm:h-7 gap-1.5 px-2.5 text-xs bg-foreground/[0.04] hover:bg-foreground/[0.08]"
            onClick={onOpenGenerationProgress}
          >
            <Sparkle size={14} />
            <span>{t('exam_sheet:aiGeneration.viewProgress', { defaultValue: '查看进度' })}</span>
          </DsButton>
        </div>
      )}

      {!readOnly && viewMode !== 'upload' && (hasQuestions || viewMode !== 'list') && pendingAuthoringDrafts.length > 0 && (() => {
        const primaryDraft = pendingAuthoringDrafts[0];
        const isAiDraft = primaryDraft.origin === 'ai_generation';
        const isConfirming = confirmingDraftJobId === primaryDraft.job_id;
        return (
          <div
            data-testid="exam-pending-drafts-banner"
            className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-primary/25 bg-primary/[0.06] px-3 py-2 sm:px-4"
            role="status"
          >
            {isAiDraft ? (
              <Sparkle size={14} className="shrink-0 text-primary" aria-hidden="true" />
            ) : (
              <Scan size={14} className="shrink-0 text-primary" aria-hidden="true" />
            )}
            <span className="min-w-0 flex-1 text-xs text-foreground tabular-nums">
              {isAiDraft
                ? t('exam_sheet:aiGeneration.pendingDraftAttributed', {
                    count: primaryDraft.question_count,
                    source: primaryDraft.sourceLabel,
                    defaultValue: `有 ${primaryDraft.question_count} 道 AI 生成待确认题目（来源：${primaryDraft.sourceLabel}）`,
                  })
                : t('exam_sheet:uploader.pendingDraftAttributed', {
                    count: primaryDraft.question_count,
                    source: primaryDraft.sourceLabel,
                    defaultValue: `有 ${primaryDraft.question_count} 道待确认题目（来源：${primaryDraft.sourceLabel}）`,
                  })}
              {pendingAuthoringDrafts.length > 1
                ? ` · 共 ${pendingAuthoringDrafts.length} 批待确认`
                : ''}
            </span>
            <div className="flex items-center gap-1.5">
              <DsButton
                size="sm"
                variant="primary"
                disabled={confirmingDraftJobId !== null}
                className="h-9 sm:h-7 gap-1.5 px-2.5 text-xs"
                onClick={() => onConfirmPendingDraft(primaryDraft)}
              >
                {isConfirming ? <CircleNotch size={13} className="animate-spin" /> : <CheckCircle size={13} />}
                <span className="tabular-nums">
                  {t('exam_sheet:aiGeneration.confirmImportNow', {
                    count: primaryDraft.question_count,
                    defaultValue: `确认入库 (${primaryDraft.question_count})`,
                  })}
                </span>
              </DsButton>
              <DsButton
                size="sm"
                variant="ghost"
                disabled={isConfirming}
                className="h-9 sm:h-7 gap-1.5 px-2.5 text-xs bg-foreground/[0.04] hover:bg-foreground/[0.08]"
                onClick={() => onReviewPendingDraft(primaryDraft)}
              >
                <span>{t('exam_sheet:uploader.review_pending_draft', { defaultValue: '逐题审阅' })}</span>
              </DsButton>
            </div>
          </div>
        );
      })()}

      {!readOnly && viewMode !== 'upload' && (
        <QBankAgentDiffBar
          examId={sessionId}
          activeQuestionId={activeQuestionId}
          onRevertQuestions={onRevertQuestions}
          onFocusQuestion={onFocusQuestionById}
        />
      )}
    </>
  );
};
