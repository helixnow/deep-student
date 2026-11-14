/**
 * 练习启动页
 * 
 * 展示所有练习模式，作为做题前的模式选择入口：
 * - 基础模式（顺序/随机/错题优先/按标签）→ 直接进入做题
 * - 高级模式（限时/模拟考/每日/组卷）→ 展开配置面板
 * - 顶部快速统计摘要
 */

import React, { lazy, Suspense, useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { DsButton } from '@/components/ui/DsButton';
import {
  ListNumbers,
  Shuffle,
  ArrowCounterClockwise,
  Tag,
  Clock,
  FileText,
  Target,
  DownloadSimple,
  CircleNotch,
  BookOpen,
  CaretLeft,
  Play,
  Flame,
  Trophy,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import type { QuestionBankStats } from '@/api/questionBankApi';
import { ratioToPercent } from '@/components/stats';
import type { PracticeMode } from '@/api/questionBankApi';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import PracticeRecords from './PracticeRecords';

// 懒加载高级模式组件
const TimedPracticeMode = lazy(() => import('./TimedPracticeMode'));
const MockExamMode = lazy(() => import('./MockExamMode'));
const DailyPracticeMode = lazy(() => import('./DailyPracticeMode'));
const PaperGenerator = lazy(() => import('./PaperGenerator'));

export interface PracticeLauncherProps {
  examId: string;
  stats?: QuestionBankStats | null;
  questions: Array<{ tags?: string[] }>;
  onStartPractice: (mode: PracticeMode, tag?: string) => void;
  onStartDrill?: (mode: PracticeMode, tag?: string) => void;
  onOpenPractice?: (id: string, submitted: boolean) => void;
  /** Opens configuration for a mode selected from the in-practice toolbar. */
  requestedMode?: 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper' | null;
  onRequestedModeHandled?: () => void;
  /** 本地会话当前题 ID：透传给限时/模拟考的答题卡高亮（未传回退全局 store） */
  currentQuestionId?: string | null;
  /** 收藏标记题目 ID 集：透传给限时/模拟考的答题卡角标（未传回退全局 store） */
  markedQuestionIds?: ReadonlySet<string>;
  /** 宿主标签页是否活跃：保活隐藏（display:none）的实例不注册 Android 返回键 handler */
  isActive?: boolean;
  className?: string;
}

type AdvancedMode = 'timed' | 'mock_exam' | 'daily' | 'paper' | null;

interface ModeCardConfig {
  key: PracticeMode;
  icon: React.ElementType;
  label: string;
  desc: string;
  isAdvanced: boolean;
}

interface TagOption {
  tag: string;
  count: number;
}

export const PracticeLauncher: React.FC<PracticeLauncherProps> = ({
  examId,
  stats,
  questions,
  onStartPractice,
  onStartDrill,
  onOpenPractice,
  requestedMode,
  onRequestedModeHandled,
  currentQuestionId,
  markedQuestionIds,
  isActive,
  className,
}) => {
  const { t } = useTranslation('practice');
  const [activeAdvanced, setActiveAdvanced] = useState<AdvancedMode>(null);
  const [isTagPickerOpen, setIsTagPickerOpen] = useState(false);
  const [drillOpen, setDrillOpen] = useState(false);

  useEffect(() => {
    // isActive === false：保活隐藏（display:none 标签页）的实例不注册，
    // 避免吞掉当前活跃视图的返回键（未传 isActive 的宿主行为不变）
    if (!activeAdvanced || isActive === false) return;
    return registerBackHandler(() => {
      setActiveAdvanced(null);
      return true;
    }, BACK_PRIORITY.view);
  }, [activeAdvanced, isActive]);
  const timedSession = useQuestionBankStore(state => state.timedSession);
  const mockExamSession = useQuestionBankStore(state => state.mockExamSession);
  const mockExamScoreCard = useQuestionBankStore(state => state.mockExamScoreCard);
  const dailyPractice = useQuestionBankStore(state => state.dailyPractice);
  const checkInCalendar = useQuestionBankStore(state => state.checkInCalendar);
  const generatedPaper = useQuestionBankStore(state => state.generatedPaper);

  const activeTimedSession = useMemo(
    () => (timedSession?.exam_id === examId ? timedSession : null),
    [timedSession, examId],
  );
  const activeMockExamSession = useMemo(
    () => (mockExamSession?.exam_id === examId ? mockExamSession : null),
    [mockExamSession, examId],
  );
  const activeDailyPractice = useMemo(
    () => (dailyPractice?.exam_id === examId ? dailyPractice : null),
    [dailyPractice, examId],
  );
  const activeCheckInCalendar = useMemo(
    () => (checkInCalendar?.exam_id === examId ? checkInCalendar : null),
    [checkInCalendar, examId],
  );
  const activeGeneratedPaper = useMemo(
    () => (generatedPaper?.exam_id === examId ? generatedPaper : null),
    [generatedPaper, examId],
  );

  useEffect(() => {
    // 恢复优先级（2026-07 修复）：进行中的会话优先于已完成的成绩单。
    // 此前旧模拟考成绩单会抢占刚水合的进行中限时会话面板。
    if (activeMockExamSession && !activeMockExamSession.is_submitted) {
      setActiveAdvanced('mock_exam');
      return;
    }
    if (activeTimedSession && !activeTimedSession.is_submitted && !activeTimedSession.is_timeout) {
      setActiveAdvanced('timed');
      return;
    }
    if (activeMockExamSession?.is_submitted && mockExamScoreCard?.exam_id === examId) {
      setActiveAdvanced('mock_exam');
    }
  }, [activeMockExamSession, activeTimedSession, mockExamScoreCard, examId]);

  useEffect(() => {
    if (!requestedMode) return;
    if (requestedMode === 'by_tag') {
      setActiveAdvanced(null);
      setIsTagPickerOpen(true);
    } else {
      setIsTagPickerOpen(false);
      setActiveAdvanced(requestedMode);
    }
    onRequestedModeHandled?.();
  }, [onRequestedModeHandled, requestedMode]);

  const tagOptions = useMemo<TagOption[]>(() => {
    const tagCounts = new Map<string, number>();
    let untaggedCount = 0;

    questions.forEach((question) => {
      const questionTags = new Set((question.tags || []).filter((tag) => tag.trim().length > 0));
      if (questionTags.size === 0) {
        untaggedCount += 1;
        return;
      }
      questionTags.forEach((tag) => {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      });
    });

    const options = Array.from(tagCounts, ([tag, count]) => ({ tag, count }))
      .sort((a, b) => a.tag.localeCompare(b.tag));
    if (untaggedCount > 0) options.push({ tag: '__untagged__', count: untaggedCount });
    return options;
  }, [questions]);

  const allTags = useMemo(
    () => tagOptions.filter(({ tag }) => tag !== '__untagged__').map(({ tag }) => tag),
    [tagOptions],
  );

  const modes: ModeCardConfig[] = useMemo(() => [
    {
      key: 'sequential',
      icon: ListNumbers,
      label: t('practice:modes.sequential.label'),
      desc: t('practice:modes.sequential.desc'),
      isAdvanced: false,
    },
    {
      key: 'random',
      icon: Shuffle,
      label: t('practice:modes.random.label'),
      desc: t('practice:modes.random.desc'),
      isAdvanced: false,
    },
    {
      key: 'review_first',
      icon: ArrowCounterClockwise,
      label: t('practice:modes.reviewFirst.label'),
      desc: t('practice:modes.reviewFirst.desc'),
      isAdvanced: false,
    },
    {
      key: 'review_only',
      icon: ArrowCounterClockwise,
      label: t('practice:modes.reviewOnly.label'),
      desc: t('practice:modes.reviewOnly.desc'),
      isAdvanced: false,
    },
    {
      key: 'by_tag',
      icon: Tag,
      label: t('practice:modes.byTag.label'),
      desc: t('practice:modes.byTag.desc'),
      isAdvanced: false,
    },
    {
      key: 'timed',
      icon: Clock,
      label: t('practice:modes.timed.label'),
      desc: t('practice:modes.timed.desc'),
      isAdvanced: true,
    },
    {
      key: 'mock_exam',
      icon: FileText,
      label: t('practice:modes.mockExam.label'),
      desc: t('practice:modes.mockExam.desc'),
      isAdvanced: true,
    },
    {
      key: 'daily',
      icon: Target,
      label: t('practice:modes.daily.label'),
      desc: t('practice:modes.daily.desc'),
      isAdvanced: true,
    },
    {
      key: 'paper',
      icon: DownloadSimple,
      label: t('practice:modes.paper.label'),
      desc: t('practice:modes.paper.desc'),
      isAdvanced: true,
    },
  ], [t]);

  // 高级模式卡片的"上次成绩 / 进行中"摘要
  const modeSummaries = useMemo<Partial<Record<PracticeMode, React.ReactNode>>>(() => {
    const summaries: Partial<Record<PracticeMode, React.ReactNode>> = {};

    if (activeTimedSession && !activeTimedSession.is_submitted && !activeTimedSession.is_timeout) {
      summaries.timed = (
        <span className="flex items-center gap-1 text-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          {t('practice:modeSummary.inProgress')}
        </span>
      );
    } else if (activeTimedSession?.is_submitted && activeTimedSession.answered_count > 0) {
      summaries.timed = (
        <span className="text-muted-foreground">
          {t('practice:modeSummary.lastAccuracy', {
            rate: Math.max(0, Math.min(100, Math.round((activeTimedSession.correct_count / activeTimedSession.answered_count) * 100))),
          })}
        </span>
      );
    }

    if (activeMockExamSession && !activeMockExamSession.is_submitted) {
      summaries.mock_exam = (
        <span className="flex items-center gap-1 text-primary">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
          {t('practice:modeSummary.inProgress')}
        </span>
      );
    } else if (mockExamScoreCard?.exam_id === examId) {
      summaries.mock_exam = (
        <span className="flex items-center gap-1 text-muted-foreground">
          <Trophy size={11} className="text-warning" />
          {t('practice:modeSummary.lastScore', { rate: Math.round(mockExamScoreCard.correct_rate) })}
        </span>
      );
    }

    if (activeCheckInCalendar && activeCheckInCalendar.streak_days > 0) {
      summaries.daily = (
        <span className="flex items-center gap-1 text-warning">
          <Flame size={11} weight="fill" />
          {t('practice:modeSummary.streak', { count: activeCheckInCalendar.streak_days })}
        </span>
      );
    } else if (activeDailyPractice) {
      summaries.daily = (
        <span className="text-muted-foreground">
          {t('practice:modeSummary.dailyProgress', {
            completed: activeDailyPractice.completed_count,
            target: activeDailyPractice.daily_target,
          })}
        </span>
      );
    }

    if (activeGeneratedPaper) {
      summaries.paper = (
        <span className="text-muted-foreground">
          {t('practice:modeSummary.paperReady', { count: activeGeneratedPaper.questions.length })}
        </span>
      );
    }

    return summaries;
  }, [
    activeTimedSession,
    activeMockExamSession,
    mockExamScoreCard,
    activeCheckInCalendar,
    activeDailyPractice,
    activeGeneratedPaper,
    examId,
    t,
  ]);

  const handleModeClick = useCallback((mode: PracticeMode, isAdvanced: boolean) => {
    if (mode === 'by_tag') {
      setActiveAdvanced(null);
      setIsTagPickerOpen(prev => !prev);
      return;
    }

    if (isAdvanced) {
      setIsTagPickerOpen(false);
      setActiveAdvanced(prev => prev === mode ? null : mode as AdvancedMode);
    } else {
      setIsTagPickerOpen(false);
      onStartPractice(mode);
    }
  }, [onStartPractice]);

  const handleStartPracticeByTag = useCallback((tag: string) => {
    setIsTagPickerOpen(false);
    onStartPractice('by_tag', tag);
  }, [onStartPractice]);

  const hasQuestions = questions.length > 0;

  // 空状态
  if (!hasQuestions) {
    return (
      <div className={cn('flex h-full flex-col items-center justify-center gap-3 px-4', className)}>
        <div className="rounded-md bg-muted p-2">
          <BookOpen size={28} className="text-muted-foreground" />
        </div>
        <div className="text-center">
          <h3 className="mb-1 text-sm font-medium">
            {t('practice:questionBank.practice.noQuestions')}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t('practice:questionBank.practice.addFirst')}
          </p>
          <p className="mt-1 max-w-xs text-xs text-muted-foreground">
            {t('practice:questionBank.practice.addFirstHint')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <CustomScrollArea
      className={cn('h-full', className)}
      viewportClassName="space-y-4 p-3 sm:p-4 pb-[calc(0.75rem+var(--mobile-safe-area-bottom,0px))]"
    >
      {/* 按标签练习：原位切换为主面板（不再叠在 9 个模式卡片下方） */}
      {isTagPickerOpen ? (
        <section className="ui-rise-in space-y-3" aria-label={t('practice:tagPicker.title')}>
          <div className="flex items-center gap-2 border-b border-border/35 pb-2.5">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('common:back')}
              title={t('common:back')}
              onClick={() => setIsTagPickerOpen(false)}
              className="!h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            >
              <CaretLeft size={16} />
            </DsButton>
            <div>
              <h3 className="text-sm font-medium">{t('practice:tagPicker.title')}</h3>
              <p className="text-xs text-muted-foreground">
                {t('practice:tagPicker.description')}
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
            {tagOptions.map(({ tag, count }) => {
              const label = tag === '__untagged__'
                ? t('practice:tagPicker.untagged')
                : tag;
              return (
                <DsButton
                  key={tag}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleStartPracticeByTag(tag)}
                  className="ui-press !h-auto !justify-start !rounded-lg !border !border-border/45 !px-3 !py-2.5 !text-left hover:border-primary/40 hover:bg-primary/[0.06] [@media(pointer:coarse)]:!min-h-11"
                >
                  <Tag size={14} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
                  <span className="font-mono text-xs tabular-nums text-muted-foreground">
                    {t('practice:tagPicker.questionCount', { count })}
                  </span>
                </DsButton>
              );
            })}
          </div>
        </section>
      ) : activeAdvanced ? (
        /* 高级模式配置面板：原位切换为主舞台（不再塞在 9 个模式卡片底部让用户滚屏找） */
        <div key={activeAdvanced} className="ui-rise-in space-y-3">
          <div className="flex min-h-9 items-center gap-2 border-b border-border/35 pb-2.5">
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('common:back')}
              title={t('common:back')}
              onClick={() => setActiveAdvanced(null)}
              className="!h-8 !w-8 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
            >
              <CaretLeft size={16} />
            </DsButton>
            <h3 className="min-w-0 truncate text-sm font-medium">
              {modes.find(m => m.key === activeAdvanced)?.label}
            </h3>
          </div>
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12">
                <CircleNotch size={24} className="animate-spin text-muted-foreground" />
              </div>
            }
          >
            {activeAdvanced === 'timed' && (
              <TimedPracticeMode
                examId={examId}
                onStart={() => onStartPractice('timed')}
                onTimeout={() => {
                  showGlobalNotification('info', t('timed.timeoutMessage'), t('timed.timeoutTitle'));
                }}
                onSubmit={() => {
                  setActiveAdvanced(null);
                }}
                currentQuestionId={currentQuestionId}
                markedQuestionIds={markedQuestionIds}
                isActive={isActive}
/>
            )}
            {activeAdvanced === 'mock_exam' && (
              <MockExamMode
                examId={examId}
                onStart={() => onStartPractice('mock_exam')}
                currentQuestionId={currentQuestionId}
                markedQuestionIds={markedQuestionIds}
                isActive={isActive}
/>
            )}
            {activeAdvanced === 'daily' && (
              <DailyPracticeMode
                examId={examId}
                onStart={() => onStartPractice('daily')}
/>
            )}
            {activeAdvanced === 'paper' && (
              <PaperGenerator
                examId={examId}
                availableTags={allTags}
                onGenerate={() => onStartPractice('paper')}
                isActive={isActive}
/>
            )}
          </Suspense>
        </div>
      ) : (
        <>
          {onOpenPractice && <PracticeRecords scopeId={examId} onOpen={onOpenPractice} />}
          {/* 单行紧凑顶栏：统计指标 + 专项训练内联入口 */}
          {(stats || onStartDrill) && (
            <div className="space-y-2.5 border-b border-border/35 pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3 px-0.5">
                {stats && (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs sm:text-sm">
                    <span className="inline-flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden="true" />
                      <span className="text-muted-foreground">{t('practice:questionBank.stats.mastered')}</span>
                      <span className="font-mono font-medium tabular-nums text-foreground">{stats.mastered}/{stats.total}</span>
                    </span>
                    {stats.review > 0 && (
                      <span className="inline-flex items-center gap-1.5 text-warning">
                        <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
                        <span className="font-mono tabular-nums">{stats.review} {t('practice:questionBank.stats.toReview')}</span>
                      </span>
                    )}
                    <span className="text-muted-foreground">
                      {t('practice:questionBank.stats.correctRate')}{' '}
                      <span className="font-mono font-medium text-foreground tabular-nums">
                        {ratioToPercent(stats.correctRate)}%
                      </span>
                    </span>
                  </div>
                )}
                {onStartDrill && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    aria-expanded={drillOpen}
                    onClick={() => setDrillOpen(v => !v)}
                    className="!h-7 !px-2.5 text-xs text-primary hover:bg-primary/10"
                  >
                    <Play size={13} weight="fill" />
                    {t('batch.drill')}
                  </DsButton>
                )}
              </div>
              {onStartDrill && drillOpen && (
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  {(['sequential', 'random', 'review_first', 'review_only'] as PracticeMode[]).map(mode => (
                    <DsButton key={mode} variant="outline" size="sm" className="!h-7 !px-2.5 text-xs" onClick={() => onStartDrill(mode)}>
                      {modes.find(m => m.key === mode)?.label}
                    </DsButton>
                  ))}
                  {!!tagOptions.length && (
                    <select
                      className="h-7 max-w-full rounded-md border border-border/50 bg-background px-2 text-xs"
                      aria-label={t('practice:tagPicker.title')}
                      defaultValue=""
                      onChange={e => { if (e.target.value) onStartDrill('by_tag', e.target.value); }}
                    >
                      <option value="" disabled>{t('practice:tagPicker.title')}</option>
                      {tagOptions.map(({ tag }) => (
                        <option key={tag} value={tag}>{tag === '__untagged__' ? t('practice:tagPicker.untagged') : tag}</option>
                      ))}
                    </select>
                  )}
                </div>
              )}
            </div>
          )}

          {/* 选择练习模式：按「即时刷题」与「模拟与专项」两个扁平分组规整 */}
          <div className="space-y-4">
            <div>
              <h3 className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1.5">
                <Play size={13} />
                {t('practice:questionBank.practice.chooseMode')}
              </h3>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {modes.filter((m) => !m.isAdvanced).map(({ key, icon: Icon, label, desc, isAdvanced }) => {
                  const isModeActive = key === 'by_tag' && isTagPickerOpen;
                  return (
                    <DsButton
                      key={key}
                      variant="ghost" size="sm"
                      onClick={() => handleModeClick(key, isAdvanced)}
                      aria-expanded={isModeActive}
                      className={cn(
                        '!relative !h-auto !min-h-[68px] !flex-col !items-start !justify-start !rounded-xl !border !p-2.5 !text-left',
                        'ui-press ui-state-colors',
                        !isModeActive && 'border-border/45 bg-transparent hover:border-border/75 hover:bg-foreground/[0.03]',
                        isModeActive && 'border-primary/45 bg-primary/[0.06] text-foreground'
                      )}
                    >
                      <div className="flex w-full items-center gap-2">
                        <div className={cn('rounded-md p-1.5 transition-colors', isModeActive ? 'bg-primary/10' : 'bg-foreground/[0.04]')}>
                          <Icon className={cn('h-4 w-4 transition-colors', isModeActive ? 'text-primary' : 'text-muted-foreground')} />
                        </div>
                        <div className="text-sm font-medium">{label}</div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{desc}</div>
                      {key === 'review_first' && stats && stats.review > 0 && (
                        <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 text-xs font-medium tabular-nums text-muted-foreground">
                          <span className="h-1.5 w-1.5 rounded-full bg-warning" aria-hidden="true" />
                          {stats.review}
                        </span>
                      )}
                    </DsButton>
                  );
                })}
              </div>
            </div>

            <div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {modes.filter((m) => m.isAdvanced).map(({ key, icon: Icon, label, desc, isAdvanced }) => {
                  const isModeActive = activeAdvanced === key;
                  return (
                    <DsButton
                      key={key}
                      variant="ghost" size="sm"
                      onClick={() => handleModeClick(key, isAdvanced)}
                      aria-expanded={isModeActive}
                      className={cn(
                        '!relative !h-auto !min-h-[68px] !flex-col !items-start !justify-start !rounded-xl !border !p-2.5 !text-left',
                        'ui-press ui-state-colors',
                        !isModeActive && 'border-border/45 bg-transparent hover:border-border/75 hover:bg-foreground/[0.03]',
                        isModeActive && 'border-primary/45 bg-primary/[0.06] text-foreground'
                      )}
                    >
                      <div className="flex w-full items-center gap-2">
                        <div className={cn('rounded-md p-1.5 transition-colors', isModeActive ? 'bg-primary/10' : 'bg-foreground/[0.04]')}>
                          <Icon className={cn('h-4 w-4 transition-colors', isModeActive ? 'text-primary' : 'text-muted-foreground')} />
                        </div>
                        <div className="text-sm font-medium">{label}</div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">{desc}</div>
                      {modeSummaries[key] && (
                        <div className="mt-1 text-xs leading-tight">{modeSummaries[key]}</div>
                      )}
                    </DsButton>
                  );
                })}
              </div>
            </div>
          </div>
        </>
      )}
    </CustomScrollArea>
  );
};

export default PracticeLauncher;
