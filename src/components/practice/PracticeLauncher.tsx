/**
 * 练习启动页
 * 
 * 展示所有练习模式，作为做题前的模式选择入口：
 * - 基础模式（顺序/随机/错题优先/按标签）→ 直接进入做题
 * - 高级模式（限时/模拟考/每日/组卷）→ 展开配置面板
 * - 顶部快速统计摘要
 * 
 * @see PracticeModeSelector 模式卡片网格
 */

import React, { lazy, Suspense, useState, useCallback, useMemo, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
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
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useQuestionBankStore } from '@/stores/questionBankStore';
import type { QuestionBankStats } from '@/api/questionBankApi';
import type { PracticeMode } from '@/api/questionBankApi';

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
  /** Opens configuration for a mode selected from the in-practice toolbar. */
  requestedMode?: 'by_tag' | 'timed' | 'mock_exam' | 'daily' | 'paper' | null;
  onRequestedModeHandled?: () => void;
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
  requestedMode,
  onRequestedModeHandled,
  className,
}) => {
  const { t } = useTranslation('practice');
  const [activeAdvanced, setActiveAdvanced] = useState<AdvancedMode>(null);
  const [isTagPickerOpen, setIsTagPickerOpen] = useState(false);
  const timedSession = useQuestionBankStore(state => state.timedSession);
  const mockExamSession = useQuestionBankStore(state => state.mockExamSession);
  const mockExamScoreCard = useQuestionBankStore(state => state.mockExamScoreCard);

  const activeTimedSession = useMemo(
    () => (timedSession?.exam_id === examId ? timedSession : null),
    [timedSession, examId],
  );
  const activeMockExamSession = useMemo(
    () => (mockExamSession?.exam_id === examId ? mockExamSession : null),
    [mockExamSession, examId],
  );

  useEffect(() => {
    if (activeMockExamSession?.is_submitted && mockExamScoreCard?.exam_id === examId) {
      setActiveAdvanced('mock_exam');
      return;
    }
    if (activeMockExamSession && !activeMockExamSession.is_submitted) {
      setActiveAdvanced('mock_exam');
      return;
    }
    if (activeTimedSession && !activeTimedSession.is_submitted && !activeTimedSession.is_timeout) {
      setActiveAdvanced('timed');
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
        </div>
      </div>
    );
  }

  return (
    <CustomScrollArea className={cn('h-full', className)} viewportClassName="space-y-4 p-3">
      {/* 快速统计 */}
      {stats && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          <div className="flex items-center gap-2">
            <div className="relative h-8 w-8">
              <svg className="w-full h-full transform -rotate-90" viewBox="0 0 40 40">
                <circle cx="20" cy="20" r="16" fill="none" stroke="currentColor" strokeWidth="3" className="text-muted/30" />
                <circle
                  cx="20" cy="20" r="16"
                  fill="none" stroke="currentColor" strokeWidth="3"
                  strokeDasharray={`${stats.total > 0 ? (stats.mastered / stats.total) * 100.5 : 0} 100.5`}
                  className="text-success"
                  strokeLinecap="round"
/>
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-[10px] font-semibold tabular-nums">
                  {stats.total > 0 ? Math.round((stats.mastered / stats.total) * 100) : 0}%
                </span>
              </div>
            </div>
            <div className="text-sm whitespace-nowrap">
              <span className="text-muted-foreground">{t('practice:questionBank.stats.mastered')} </span>
              <span className="font-medium">{stats.mastered}</span>
              <span className="text-muted-foreground">/ {stats.total}</span>
            </div>
          </div>
          {stats.review > 0 && (
            <div className="flex items-center gap-1.5 text-sm text-warning">
              <span className="h-1.5 w-1.5 rounded-full bg-warning" />
              <span>{stats.review} {t('practice:questionBank.stats.toReview')}</span>
            </div>
          )}
          <div className="text-sm text-muted-foreground">
            {t('practice:questionBank.stats.correctRate')}{' '}
            <span className="font-medium text-foreground tabular-nums">
              {Math.round(stats.correctRate * 100)}%
            </span>
          </div>
        </div>
      )}

      {/* 选择练习模式 */}
      <div>
        <h3 className="text-sm font-medium text-muted-foreground mb-3 flex items-center gap-1.5">
          <Play size={14} />
          {t('practice:questionBank.practice.chooseMode')}
        </h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {modes.map(({ key, icon: Icon, label, desc, isAdvanced }) => {
            const isActive = activeAdvanced === key || (key === 'by_tag' && isTagPickerOpen);
            return (
              <NotionButton
                key={key}
                variant="ghost" size="sm"
                onClick={() => handleModeClick(key, isAdvanced)}
                className={cn(
                  '!relative !h-auto !min-h-[76px] !flex-col !items-start !justify-start !rounded-md !border !p-3 !text-left',
                  !isActive && 'border-border/60 bg-transparent hover:border-border hover:bg-accent',
                  isActive && 'border-primary/50 bg-primary/10 text-foreground'
                )}
              >
                <div className={cn('rounded-md p-1.5 transition-colors', isActive ? 'bg-primary/10' : 'bg-muted')}>
                  <Icon className={cn('h-4 w-4 transition-colors', isActive ? 'text-primary' : 'text-muted-foreground')} />
                </div>
                <div>
                  <div className="text-sm font-medium">{label}</div>
                  <div className="text-[11px] text-muted-foreground mt-0.5">{desc}</div>
                </div>
                {/* 错题数量 badge */}
                {key === 'review_first' && stats && stats.review > 0 && (
                  <Badge variant="secondary" className="absolute right-2 top-2 h-5 bg-warning/10 text-[10px] text-warning">
                    {stats.review}
                  </Badge>
                )}
              </NotionButton>
            );
          })}
        </div>
      </div>

      {isTagPickerOpen && (
        <section className="border-t border-border/50 pt-3" aria-label={t('practice:tagPicker.title')}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium">{t('practice:tagPicker.title')}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('practice:tagPicker.description')}
              </p>
            </div>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('common:back')}
              title={t('common:back')}
              onClick={() => setIsTagPickerOpen(false)}
            >
              <CaretLeft size={16} />
            </NotionButton>
          </div>
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
            {tagOptions.map(({ tag, count }) => {
              const label = tag === '__untagged__'
                ? t('practice:tagPicker.untagged')
                : tag;
              return (
                <NotionButton
                  key={tag}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleStartPracticeByTag(tag)}
                  className="!h-auto !justify-start !rounded-md !border !border-border/60 !px-2.5 !py-2 !text-left hover:border-primary/40 hover:bg-primary/10"
                >
                  <Tag size={14} className="shrink-0 text-primary" />
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">{label}</span>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {t('practice:tagPicker.questionCount', { count })}
                  </span>
                </NotionButton>
              );
            })}
          </div>
        </section>
      )}

      {/* 高级模式配置面板 */}
      {activeAdvanced && (
        <div className="border-t border-border/40 pt-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-medium">
              {modes.find(m => m.key === activeAdvanced)?.label}
            </h3>
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              aria-label={t('common:back')}
              title={t('common:back')}
              onClick={() => setActiveAdvanced(null)}
            >
              <CaretLeft size={16} />
            </NotionButton>
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
/>
            )}
            {activeAdvanced === 'mock_exam' && (
              <MockExamMode
                examId={examId}
                onStart={() => onStartPractice('mock_exam')}
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
/>
            )}
          </Suspense>
        </div>
      )}
    </CustomScrollArea>
  );
};

export default PracticeLauncher;
